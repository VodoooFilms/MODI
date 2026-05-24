package com.mobmidi.controller

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Manages Bluetooth LE MIDI Peripheral advertising, GATT connections, and MIDI message transfers.
 * Optimized for ultra-low latency routing to external hosts (iOS, macOS, Windows).
 */
class MidiBleManager(private val context: Context, private val statusCallback: ConnectionStatusListener) {

    interface ConnectionStatusListener {
        fun onConnectionStatusChanged(isConnected: Boolean, deviceName: String?)
        fun onTransportStateChanged(status: String) {}
    }

    companion object {
        private const val TAG = "MidiBleManager"
        
        // Standard MIDI over BLE Service and Characteristic UUIDs
        val MIDI_SERVICE_UUID: UUID = UUID.fromString("03B80E5A-EDE8-4B33-A751-6CE34EC4C700")
        val MIDI_CHARACTERISTIC_UUID: UUID = UUID.fromString("7772E5DB-3868-4112-A1A9-F2669D106BF3")
        val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }

    private val bluetoothManager: BluetoothManager? = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager?.adapter
    private var bluetoothLeAdvertiser: BluetoothLeAdvertiser? = null
    private var bluetoothGattServer: BluetoothGattServer? = null
    private var midiCharacteristic: BluetoothGattCharacteristic? = null

    // Set of currently connected hosts (devices) that have enabled notifications
    private val connectedDevices = ConcurrentHashMap<String, BluetoothDevice>()
    private val subscribedDevices = ConcurrentHashMap<String, BluetoothDevice>()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var isAdvertising = false
    private val startTime = SystemClock.elapsedRealtime()
    private var lastTransportStatus = "Inicializando BLE MIDI"

    private data class MidiMessage(val status: Int, val data1: Int, val data2: Int)

    // Queue of logical MIDI events. BLE packet timestamps are generated at transmit time.
    private val messageQueue = java.util.concurrent.ConcurrentLinkedQueue<MidiMessage>()
    @Volatile
    private var isSending = false
    @Volatile
    private var pendingNotifications = 0

    private val advertiseWatchdog = object : Runnable {
        override fun run() {
            if (bluetoothAdapter?.isEnabled != true) {
                reportTransportState("Bluetooth desactivado")
            } else if (!isAdvertising) {
                reportTransportState("Reintentando advertising BLE")
                start()
            } else if (subscribedDevices.isEmpty()) {
                reportTransportState("Anunciando BLE MIDI")
            }

            mainHandler.postDelayed(this, 4_000L)
        }
    }

    /**
     * Initializes the MIDI GATT service and starts BLE advertising.
     */
    fun start() {
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled) {
            Log.e(TAG, "Bluetooth is disabled or not supported on this device.")
            reportTransportState("Bluetooth no disponible")
            return
        }

        bluetoothLeAdvertiser = bluetoothAdapter.bluetoothLeAdvertiser
        if (bluetoothLeAdvertiser == null) {
            Log.e(TAG, "BLE Advertising is not supported on this hardware.")
            reportTransportState("Advertising BLE no soportado")
            return
        }

        if (bluetoothGattServer == null || midiCharacteristic == null) {
            setupGattServer()
        }

        if (!isAdvertising) {
            startAdvertising()
        }

        mainHandler.removeCallbacks(advertiseWatchdog)
        mainHandler.postDelayed(advertiseWatchdog, 4_000L)
    }

    /**
     * Stops BLE advertising and teardowns GATT server connectivity.
     */
    fun stop() {
        mainHandler.removeCallbacks(advertiseWatchdog)
        stopAdvertising()
        bluetoothGattServer?.apply {
            clearServices()
            close()
        }
        bluetoothGattServer = null
        connectedDevices.clear()
        subscribedDevices.clear()
        messageQueue.clear()
        synchronized(this) {
            isSending = false
            pendingNotifications = 0
        }
        reportTransportState("BLE MIDI detenido")
        statusCallback.onConnectionStatusChanged(false, null)
    }

    private fun setupGattServer() {
        bluetoothGattServer?.close()

        val gattServer = bluetoothManager?.openGattServer(context, gattServerCallback)
        if (gattServer == null) {
            Log.e(TAG, "Unable to open BluetoothGattServer.")
            reportTransportState("No se pudo abrir GATT server")
            return
        }
        bluetoothGattServer = gattServer

        // Create the MIDI Service
        val midiService = BluetoothGattService(MIDI_SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)

        // Create the MIDI Characteristic (Read, Write Without Response, Write, Notify)
        val charProps = BluetoothGattCharacteristic.PROPERTY_READ or
                BluetoothGattCharacteristic.PROPERTY_WRITE or
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
                BluetoothGattCharacteristic.PROPERTY_NOTIFY

        val charPermissions = BluetoothGattCharacteristic.PERMISSION_READ or
                BluetoothGattCharacteristic.PERMISSION_WRITE

        val characteristic = BluetoothGattCharacteristic(MIDI_CHARACTERISTIC_UUID, charProps, charPermissions)

        // Add the Client Characteristic Configuration Descriptor (CCCD) for Enable Notifications
        val descriptor = BluetoothGattDescriptor(
            CLIENT_CHARACTERISTIC_CONFIG_UUID,
            BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE
        )
        characteristic.addDescriptor(descriptor)

        midiService.addCharacteristic(characteristic)
        gattServer.addService(midiService)
        midiCharacteristic = characteristic
    }

    private fun startAdvertising() {
        val advertiser = bluetoothLeAdvertiser ?: return
        if (isAdvertising) return
        reportTransportState("Iniciando advertising BLE")

        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setConnectable(true)
            .setTimeout(0)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .build()

        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(true)
            .addServiceUuid(ParcelUuid(MIDI_SERVICE_UUID))
            .build()

        val scanResponse = AdvertiseData.Builder()
            .addServiceUuid(ParcelUuid(MIDI_SERVICE_UUID))
            .build()

        try {
            advertiser.startAdvertising(settings, data, scanResponse, advertiseCallback)
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException: Missing required permissions for BLE Advertising.", e)
            reportTransportState("Permisos BLE faltantes")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start BLE advertising: ${e.message}")
            reportTransportState("Error al anunciar BLE")
        }
    }

    private fun stopAdvertising() {
        val advertiser = bluetoothLeAdvertiser ?: return
        try {
            advertiser.stopAdvertising(advertiseCallback)
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException while stopping advertisement.", e)
        }
        isAdvertising = false
        reportTransportState("Advertising BLE detenido")
    }

    /**
     * Sends a MIDI event over BLE.
     * Maps the message into BLE MIDI packet structures:
     * [Header Byte (0x80 | Timestamp High), Timestamp Low (0x80 | Timestamp Low), Status, Data1, Data2]
     */
    fun sendMidiEvent(status: Int, data1: Int, data2: Int) {
        if (subscribedDevices.isEmpty()) return
        messageQueue.add(MidiMessage(status, data1, data2))
        triggerSend()
    }

    fun getLastTransportStatus(): String = lastTransportStatus

    private fun reportTransportState(status: String) {
        if (lastTransportStatus == status) return
        lastTransportStatus = status
        Log.d(TAG, status)
        statusCallback.onTransportStateChanged(status)
    }

    private fun triggerSend() {
        synchronized(this) {
            if (isSending) return
            isSending = true
        }
        sendNextMessage()
    }

    private fun sendNextMessage() {
        val nextMessage = messageQueue.poll()
        if (nextMessage == null) {
            synchronized(this) {
                isSending = false
            }
            return
        }

        val characteristic = midiCharacteristic ?: run {
            synchronized(this) { isSending = false }
            return
        }
        val gattServer = bluetoothGattServer ?: run {
            synchronized(this) { isSending = false }
            return
        }

        val notificationPacket = encodeMidiMessage(nextMessage)
        
        val devicesToNotify = subscribedDevices.values.toList()
        if (devicesToNotify.isEmpty()) {
            synchronized(this) {
                isSending = false
            }
            return
        }

        // CRITICAL FIX: Set characteristic value inside loop to avoid race condition
        // Each device needs fresh packet data to prevent stale reads
        var notifiedCount = 0
        var failedDevices = 0
        
        for (device in devicesToNotify) {
            try {
                // Set characteristic value immediately before each notify call
                characteristic.value = notificationPacket
                val success = gattServer.notifyCharacteristicChanged(device, characteristic, false)
                if (success) {
                    notifiedCount++
                } else {
                    Log.e(TAG, "Failed to notify characteristic changed for ${device.address}")
                    failedDevices++
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException: missing permissions to notify device: ${device.address}", e)
                failedDevices++
            } catch (e: Exception) {
                Log.e(TAG, "Unexpected error notifying device ${device.address}: ${e.message}", e)
                failedDevices++
            }
        }

        // CRITICAL FIX: Properly synchronize counter updates and state transitions
        synchronized(this) {
            pendingNotifications = maxOf(0, pendingNotifications - notifiedCount)
            
            // Reset sending flag only when all notifications are complete or failed
            if (notifiedCount == 0 || pendingNotifications <= 0) {
                isSending = false
                pendingNotifications = 0
                
                // If all devices failed, clear queue to prevent infinite retry loop
                if (failedDevices >= devicesToNotify.size) {
                    messageQueue.clear()
                }
            }
        }

        // Continue processing queue if there are more messages
        if (notifiedCount > 0 && pendingNotifications == 0) {
            mainHandler.post {
                triggerSend()
            }
        }
    }

    private fun encodeMidiMessage(message: MidiMessage): ByteArray {
        // For live performance we timestamp at the exact transmit moment to avoid queued events being
        // interpreted with stale timing on the host.
        val currentTimestamp = ((SystemClock.elapsedRealtime() - startTime) and 0x1FFF).toInt()
        val timestampHigh = (currentTimestamp shr 7) and 0x3F
        val timestampLow = currentTimestamp and 0x7F

        val header = (0x80 or timestampHigh).toByte()
        val timestampByte = (0x80 or timestampLow).toByte()

        return byteArrayOf(
            header,
            timestampByte,
            message.status.toByte(),
            message.data1.toByte(),
            message.data2.toByte()
        )
    }

    // GATT Server Callback handling state changes and client read/writes
    private val gattServerCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            try {
                val deviceName = device.name ?: "Unknown BLE MIDI Host"
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    Log.i(TAG, "Device connected to MIDI GATT Server: $deviceName (${device.address})")
                    connectedDevices[device.address] = device
                    reportTransportState("Host BLE conectado: $deviceName")
                    // Notify UI that a device has connected (either fully integrated or preparing to register MIDI)
                    statusCallback.onConnectionStatusChanged(true, deviceName)
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    Log.i(TAG, "Device disconnected from MIDI GATT Server: ${device.address}")
                    connectedDevices.remove(device.address)
                    subscribedDevices.remove(device.address)
                    
                    synchronized(this@MidiBleManager) {
                        if (subscribedDevices.isEmpty()) {
                            messageQueue.clear()
                            isSending = false
                            pendingNotifications = 0
                        }
                    }
                    
                    val nextDevice = subscribedDevices.values.firstOrNull() ?: connectedDevices.values.firstOrNull()
                    reportTransportState(if (nextDevice != null) "Host BLE presente: ${nextDevice.name ?: "desconocido"}" else "Anunciando BLE MIDI")
                    statusCallback.onConnectionStatusChanged(nextDevice != null, nextDevice?.name)
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "Permission needed for reading device name", e)
                reportTransportState("Sin permiso para leer host BLE")
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            Log.d(TAG, "onNotificationSent: device=${device.address}, status=$status")
            val shouldSendNext = synchronized(this@MidiBleManager) {
                if (pendingNotifications > 0) {
                    pendingNotifications--
                }
                if (pendingNotifications == 0) {
                    isSending = false
                    true
                } else {
                    false
                }
            }
            if (shouldSendNext) {
                sendNextMessage()
            }
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic
        ) {
            if (characteristic.uuid == MIDI_CHARACTERISTIC_UUID) {
                bluetoothGattServer?.sendResponse(
                    device,
                    requestId,
                    BluetoothGatt.GATT_SUCCESS,
                    offset,
                    characteristic.value ?: byteArrayOf()
                )
            } else {
                bluetoothGattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) {
            if (characteristic.uuid == MIDI_CHARACTERISTIC_UUID) {
                if (value != null && value.isNotEmpty()) {
                    // For a MIDI Peripheral, we can receive MIDI events (like clocks/sysex) from the host DAW.
                    // This app is primary a MIDI transmitter, but we handle writes cleanly.
                    characteristic.value = value
                }
                if (responseNeeded) {
                    bluetoothGattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                }
            } else {
                if (responseNeeded) {
                    bluetoothGattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
                }
            }
        }

        override fun onDescriptorReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            descriptor: BluetoothGattDescriptor
        ) {
            bluetoothGattServer?.sendResponse(
                device,
                requestId,
                BluetoothGatt.GATT_SUCCESS,
                offset,
                descriptor.value ?: byteArrayOf()
            )
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?
        ) {
            if (descriptor.uuid == CLIENT_CHARACTERISTIC_CONFIG_UUID) {
                if (value != null) {
                    descriptor.value = value
                    if (value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                        Log.i(TAG, "Device subscribed to MIDI Notifications: ${device.address}")
                        subscribedDevices[device.address] = device
                        reportTransportState("MIDI activo con ${device.name ?: "host BLE"}")
                        try {
                            statusCallback.onConnectionStatusChanged(true, device.name ?: "Unknown Device")
                        } catch (e: SecurityException) {
                            statusCallback.onConnectionStatusChanged(true, "Unknown BLE MIDI Host")
                        }
                    } else if (value.contentEquals(BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)) {
                        Log.i(TAG, "Device unsubscribed from MIDI Notifications: ${device.address}")
                        subscribedDevices.remove(device.address)
                        reportTransportState("Host BLE sin suscripcion MIDI")
                    }
                }
                if (responseNeeded) {
                    bluetoothGattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                }
            } else {
                if (responseNeeded) {
                    bluetoothGattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
                }
            }
        }
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            Log.i(TAG, "LE MIDI Peripheral advertising successfully started.")
            isAdvertising = true
            reportTransportState("Anunciando BLE MIDI")
        }

        override fun onStartFailure(errorCode: Int) {
            Log.e(TAG, "LE MIDI peripheral advertising failed to start. Error code: $errorCode")
            isAdvertising = false
            reportTransportState("Fallo advertising BLE: $errorCode")
        }
    }
}
