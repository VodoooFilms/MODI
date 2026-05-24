export interface CodeFile {
  name: string;
  path: string;
  language: "kotlin" | "xml" | "gradle";
  description: string;
  code: string;
}

export const androidCodeFiles: CodeFile[] = [
  {
    name: "MainActivity.kt",
    path: "android/app/src/main/java/com/mobmidi/controller/MainActivity.kt",
    language: "kotlin",
    description: "Activity setup managing lifecycle, Android 12+ request Permissions framework, and bootstrapping the ultra-low latency local AudioTrack Synthesizer audio Fallback pipeline.",
    code: `package com.mobmidi.controller

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Toast

/**
 * Entry Point of MobMidi Android Application.
 * Manages Permissions Flow, Bluetooth GATT server, and Low-Latency Native Audio Fallback.
 */
class MainActivity : Activity(), MidiBleManager.ConnectionStatusListener, PianoView.MidiEventListener {

    companion object {
        private const val TAG = "MainActivity"
        private const val PERMISSION_REQUEST_CODE = 101
        private const val SAMPLE_RATE = 44100
    }

    private lateinit var pianoView: PianoView
    private var midiBleManager: MidiBleManager? = null



    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Lock landscape mode programmatically (if not declared in Manifest)
        requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE

        // Initialize Piano View as the full content view
        pianoView = PianoView(this)
        pianoView.setMidiEventListener(this)
        setContentView(pianoView)

        // Initialize Bluetooth BLE Midi Manager
        midiBleManager = MidiBleManager(this, this)

        // Check & request Bluetooth / Location permissions
        if (checkPermissions()) {
            midiBleManager?.start()
        } else {
            requestPermissions()
        }


    }

    override fun onDestroy() {
        super.onDestroy()
        midiBleManager?.stop()

    }



    // --- PianoView MidiEventListener Callbacks ---

    override fun onNoteOn(noteCode: Int, velocity: Int) {
        // Send BLE MIDI packet (Status byte for Note On is 0x90)
        // Default MIDI channel = 0 (so Note On status byte = 0x90 | 0x00)
        midiBleManager?.sendMidiEvent(0x90, noteCode, velocity)
    }

    override fun onNoteOff(noteCode: Int) {
        // Send BLE MIDI packet (Status byte for Note Off is 0x80)
        midiBleManager?.sendMidiEvent(0x80, noteCode, 0)
    }

    override fun onPitchBend(value: Int) {
        // Pitch Bend status byte = 0xE0
        // Sends 14-bit data split into two 7-bit bytes: low byte (bits 0-6), high byte (bits 7-13)
        val lsb = value and 0x7F
        val msb = (value shr 7) and 0x7F
        midiBleManager?.sendMidiEvent(0xE0, lsb, msb)
    }

    override fun onControlChange(control: Int, value: Int) {
        // CC status byte = 0xB0
        midiBleManager?.sendMidiEvent(0xB0, control, value)
    }

    override fun onSustainChanged(isSustainOn: Boolean) {
        // Handled in onControlChange (CC#64) on PianoView already, but logged here
        Log.d(TAG, "Sustain changed: \$isSustainOn")
    }

    override fun onVelocityToggleChanged(isDynamic: Boolean) {
        Log.d(TAG, "Velocity dynamics changed: \$isDynamic")
    }

    override fun onOctaveChanged(newOctave: Int) {
        Log.d(TAG, "Octave Shifted to: \$newOctave")
    }

    // --- Connection Status callback from BLE GATT Server ---
    override fun onConnectionStatusChanged(isConnected: Boolean, deviceName: String?) {
        runOnUiThread {
            pianoView.setBleConnectionStatus(isConnected, deviceName)
            if (isConnected) {
                Toast.makeText(this, "BLE Host connected: \$deviceName", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "BLE Disconnected", Toast.LENGTH_SHORT).show()
            }
        }
    }



    // --- Permissions Framework Implementation ---
    private fun checkPermissions(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ requires specialized BLE permissions
            return checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED &&
                   checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED &&
                   checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
        } else {
            // Older Androids require fine location access to execute BLE scans and state connections
            return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun requestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            requestPermissions(
                arrayOf(
                    Manifest.permission.BLUETOOTH_ADVERTISE,
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN
                ),
                PERMISSION_REQUEST_CODE
            )
        } else {
            requestPermissions(
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION),
                PERMISSION_REQUEST_CODE
            )
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode == PERMISSION_REQUEST_CODE) {
            var allGranted = true
            for (result in grantResults) {
                if (result != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false
                    break
                }
            }
            if (allGranted) {
                midiBleManager?.start()
                Toast.makeText(this, "BLE permissions accepted.", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "BLE permissions denied. BLE MIDI will not function.", Toast.LENGTH_LONG).show()
            }
        }
    }
}`
  },
  {
    name: "MidiBleManager.kt",
    path: "android/app/src/main/java/com/mobmidi/controller/MidiBleManager.kt",
    language: "kotlin",
    description: "Sets up Bluetooth LE GATT Server, creates MIDI Service & Characteristic, advertises as connectable peripheral, and builds high-precision 13-bit timestamps required by macOS / iOS MIDI BLE protocol.",
    code: `package com.mobmidi.controller

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
import android.os.ParcelUuid
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

    private var isAdvertising = false
    private val startTime = System.currentTimeMillis()

    // Queue of MIDI packets to be sent
    private val messageQueue = java.util.concurrent.ConcurrentLinkedQueue<ByteArray>()
    @Volatile
    private var isSending = false
    @Volatile
    private var pendingNotifications = 0

    /**
     * Initializes the MIDI GATT service and starts BLE advertising.
     */
    fun start() {
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled) {
            Log.e(TAG, "Bluetooth is disabled or not supported on this device.")
            return
        }

        bluetoothLeAdvertiser = bluetoothAdapter.bluetoothLeAdvertiser
        if (bluetoothLeAdvertiser == null) {
            Log.e(TAG, "BLE Advertising is not supported on this hardware.")
            return
        }

        setupGattServer()
        startAdvertising()
    }

    /**
     * Stops BLE advertising and teardowns GATT server connectivity.
     */
    fun stop() {
        stopAdvertising()
        bluetoothGattServer?.apply {
            clearServices()
            close()
        }
        bluetoothGattServer = null
        connectedDevices.clear()
        subscribedDevices.clear()
        statusCallback.onConnectionStatusChanged(false, null)
    }

    private fun setupGattServer() {
        val gattServer = bluetoothManager?.openGattServer(context, gattServerCallback)
        if (gattServer == null) {
            Log.e(TAG, "Unable to open BluetoothGattServer.")
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
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start BLE advertising: \${e.message}")
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
    }

    /**
     * Sends a MIDI event over BLE.
     * Maps the message into BLE MIDI packet structures:
     * [Header Byte (0x80 | Timestamp High), Timestamp Low (0x80 | Timestamp Low), Status, Data1, Data2]
     */
    fun sendMidiEvent(status: Int, data1: Int, data2: Int) {
        if (subscribedDevices.isEmpty()) return

        // Calculate 13-bit timestamp relative to start time (standard BLE MIDI requirement)
        val currentTimestamp = ((System.currentTimeMillis() - startTime) and 0x1FFF).toInt()
        val timestampHigh = (currentTimestamp shr 7) and 0x3F
        val timestampLow = currentTimestamp and 0x7F

        val header = (0x80 or timestampHigh).toByte()
        val timestampByte = (0x80 or timestampLow).toByte()

        val midiPacket = byteArrayOf(
            header,
            timestampByte,
            status.toByte(),
            data1.toByte(),
            data2.toByte()
        )

        messageQueue.add(midiPacket)
        triggerSend()
    }

    private fun triggerSend() {
        synchronized(this) {
            if (isSending) return
            isSending = true
        }
        sendNextMessage()
    }

    private fun sendNextMessage() {
        val nextPacket = messageQueue.poll()
        if (nextPacket == null) {
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

        characteristic.value = nextPacket

        val devicesToNotify = subscribedDevices.values.toList()
        if (devicesToNotify.isEmpty()) {
            synchronized(this) {
                isSending = false
            }
            return
        }

        synchronized(this) {
            pendingNotifications = devicesToNotify.size
        }

        var notifiedCount = 0
        for (device in devicesToNotify) {
            try {
                val success = gattServer.notifyCharacteristicChanged(device, characteristic, false)
                if (success) {
                    notifiedCount++
                } else {
                    Log.e(TAG, "Failed to notify characteristic changed for \${device.address}")
                    synchronized(this) {
                        if (pendingNotifications > 0) pendingNotifications--
                    }
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException: missing permissions to notify device: \${device.address}", e)
                synchronized(this) {
                    if (pendingNotifications > 0) pendingNotifications--
                }
            }
        }

        if (notifiedCount == 0 || pendingNotifications <= 0) {
            synchronized(this) {
                isSending = false
                pendingNotifications = 0
            }
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                triggerSend()
            }
        }
    }

    // GATT Server Callback handling state changes and client read/writes
    private val gattServerCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            try {
                val deviceName = device.name ?: "Unknown BLE MIDI Host"
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    Log.i(TAG, "Device connected to MIDI GATT Server: \$deviceName (\${device.address})")
                    connectedDevices[device.address] = device
                    // Notify UI that a device has connected (either fully integrated or preparing to register MIDI)
                    statusCallback.onConnectionStatusChanged(true, deviceName)
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    Log.i(TAG, "Device disconnected from MIDI GATT Server: \${device.address}")
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
                    statusCallback.onConnectionStatusChanged(nextDevice != null, nextDevice?.name)
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "Permission needed for reading device name", e)
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            Log.d(TAG, "onNotificationSent: device=\${device.address}, status=\$status")
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
                        Log.i(TAG, "Device subscribed to MIDI Notifications: \${device.address}")
                        subscribedDevices[device.address] = device
                        try {
                            statusCallback.onConnectionStatusChanged(true, device.name ?: "Unknown Device")
                        } catch (e: SecurityException) {
                            statusCallback.onConnectionStatusChanged(true, "Unknown BLE MIDI Host")
                        }
                    } else if (value.contentEquals(BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE)) {
                        Log.i(TAG, "Device unsubscribed from MIDI Notifications: \${device.address}")
                        subscribedDevices.remove(device.address)
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
        }

        override fun onStartFailure(errorCode: Int) {
            Log.e(TAG, "LE MIDI peripheral advertising failed to start. Error code: \$errorCode")
            isAdvertising = false
        }
    }
}`
  },
  {
    name: "PianoView.kt",
    path: "android/app/src/main/java/com/mobmidi/controller/PianoView.kt",
    language: "kotlin",
    description: "Draws the control center and the 1.5 octave multi-touch keyboard. Intercepts screen gestures, handles advanced Android MotionEvent pointers, transposes notes dynamically, and calculates vertical touch velocity.",
    code: `package com.mobmidi.controller

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import kotlin.math.max
import kotlin.math.min

/**
 * A Custom View that renders the professional BLE MIDI controller interface.
 * Implements a top control bar (20%) and a multi-touch keyboard (80%) of 1.5 octaves.
 */
class PianoView @JvmOverloads constructor(
    context: Context,
    attrs: android.util.AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    interface MidiEventListener {
        fun onNoteOn(noteCode: Int, velocity: Int)
        fun onNoteOff(noteCode: Int)
        fun onPitchBend(value: Int)
        fun onControlChange(control: Int, value: Int)
        fun onSustainChanged(isSustainOn: Boolean)
        fun onVelocityToggleChanged(isDynamic: Boolean)
        fun onOctaveChanged(newOctave: Int)
    }

    private var eventListener: MidiEventListener? = null
    fun setMidiEventListener(listener: MidiEventListener) {
        this.eventListener = listener
    }

    private var isBleConnected = false
    private var bleDeviceName: String? = null
    
    private var currentOctave = 3
    private var isSustainActive = false
    private var isDynamicVelocity = true
    
    private var pitchBendValue = 8192
    private var modulationValue = 0
    
    private class ActiveTouch {
        var touchType: TouchType = TouchType.NONE
        var noteTriggered: Int = -1
        var ribbonId: Int = -1
    }
    
    private enum TouchType {
        NONE, PIANO_KEY, PITCH_BEND, MODULATION
    }
    
    private val activeTouches = HashMap<Int, ActiveTouch>()
    private val currentlyPressedNotes = HashSet<Int>()

    // Paints
    private val bgPaint = Paint().apply { color = Color.parseColor("#121214"); style = Paint.Style.FILL }
    private val whiteKeyPaint = Paint().apply { color = Color.WHITE; style = Paint.Style.FILL }
    private val whiteKeyBorderPaint = Paint().apply { color = Color.parseColor("#E4E4E7"); style = Paint.Style.STROKE; strokeWidth = 2f }
    private val whiteKeyActivePaint = Paint().apply { color = Color.parseColor("#93C5FD"); style = Paint.Style.FILL }
    
    private val blackKeyPaint = Paint().apply { color = Color.parseColor("#1F2937"); style = Paint.Style.FILL }
    private val blackKeyActivePaint = Paint().apply { color = Color.parseColor("#3B82F6"); style = Paint.Style.FILL }
    
    private val ledConnectedPaint = Paint().apply { color = Color.parseColor("#3B82F6"); isAntiAlias = true }
    private val ledDisconnectedPaint = Paint().apply { color = Color.parseColor("#EF4444"); isAntiAlias = true }
    private val ledGlowPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.FILL }
    
    private val textPaint = Paint().apply { color = Color.WHITE; textSize = 40f; isAntiAlias = true; textAlign = Paint.Align.CENTER }
    private val labelPaint = Paint().apply { color = Color.parseColor("#9CA3AF"); textSize = 26f; isAntiAlias = true; textAlign = Paint.Align.CENTER }
    
    private val buttonPaint = Paint().apply { color = Color.parseColor("#27272A"); style = Paint.Style.FILL }
    private val buttonActivePaint = Paint().apply { color = Color.parseColor("#3F3F46"); style = Paint.Style.FILL }
    private val borderPaint = Paint().apply { color = Color.parseColor("#3F3F46"); style = Paint.Style.STROKE; strokeWidth = 3f }
    
    private val ribbonBgPaint = Paint().apply { color = Color.parseColor("#18181B"); style = Paint.Style.FILL }
    private val ribbonFillPaint = Paint().apply { color = Color.parseColor("#2563EB"); style = Paint.Style.FILL }

    private var navRect = RectF()
    private var keyboardRect = RectF()
    
    private var btnOctaveDown = RectF()
    private var btnOctaveUp = RectF()
    private var btnSustain = RectF()
    private var btnVelocity = RectF()
    private var rectPitchBend = RectF()
    private var rectModulation = RectF()
    
    private val totalWhiteKeys = 11
    private var whiteKeyWidth = 0f
    private var blackKeyWidth = 0f
    private var blackKeyHeight = 0f

    private val whiteKeySemitones = intArrayOf(0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17)
    private val blackKeyWhiteParentIndices = intArrayOf(0, 1, 3, 4, 5, 7, 8)
    private val blackKeySemitones = intArrayOf(1, 3, 6, 8, 10, 13, 15)

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val width = w.toFloat()
        val height = h.toFloat()

        val navHeight = height * 0.20f
        navRect.set(0f, 0f, width, navHeight)
        keyboardRect.set(0f, navHeight, width, height)

        val padding = 15f
        val topY = padding
        val bottomY = navHeight - padding

        val btnW = (width * 0.06f).coerceAtLeast(60f)
        val octaveCenterX = width * 0.22f
        btnOctaveDown.set(octaveCenterX - btnW - 30f, topY, octaveCenterX - 30f, bottomY)
        btnOctaveUp.set(octaveCenterX + 30f, topY, octaveCenterX + btnW + 30f, bottomY)

        val ribbonStart = width * 0.35f
        val ribbonEnd = width * 0.68f
        val totalRibbonWidth = ribbonEnd - ribbonStart
        val ribbonW = totalRibbonWidth / 2f
        
        rectPitchBend.set(ribbonStart, topY + 5f, ribbonStart + ribbonW - 15f, bottomY - 5f)
        rectModulation.set(ribbonStart + ribbonW + 15f, topY + 5f, ribbonEnd, bottomY - 5f)

        val utilStart = width * 0.72f
        val utilWidth = (width - utilStart) / 2f - padding
        
        btnSustain.set(utilStart, topY, utilStart + utilWidth, bottomY)
        btnVelocity.set(utilStart + utilWidth + padding, topY, width - padding, bottomY)

        whiteKeyWidth = width / totalWhiteKeys
        blackKeyWidth = whiteKeyWidth * 0.58f
        blackKeyHeight = (height - navHeight) * 0.58f
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)
        drawNavBar(canvas)
        drawKeyboard(canvas)
    }

    private fun drawNavBar(canvas: Canvas) {
        canvas.drawLine(0f, navRect.bottom, width.toFloat(), navRect.bottom, borderPaint)

        // Connection LED
        val ledX = width * 0.05f
        val ledY = navRect.centerY()
        val ledRadius = 14f
        
        ledGlowPaint.color = if (isBleConnected) Color.parseColor("#3B82F6") else Color.parseColor("#EF4444")
        ledGlowPaint.alpha = 50
        canvas.drawCircle(ledX, ledY, ledRadius + 10f, ledGlowPaint)
        
        val ledSolidPaint = if (isBleConnected) ledConnectedPaint else ledDisconnectedPaint
        canvas.drawCircle(ledX, ledY, ledRadius, ledSolidPaint)

        val subText = if (isBleConnected) (bleDeviceName ?: "CONN") else "BLE MIDI"
        canvas.drawText(subText, ledX, ledY + 45f, labelPaint.apply { textSize = 22f })

        // Octave [- / +]
        canvas.drawRoundRect(btnOctaveDown, 12f, 12f, buttonPaint)
        canvas.drawRoundRect(btnOctaveDown, 12f, 12f, borderPaint)
        canvas.drawText("-", btnOctaveDown.centerX(), btnOctaveDown.centerY() + 15f, textPaint.apply { textSize = 50f })

        val octaveCenterX = (btnOctaveDown.right + btnOctaveUp.left) / 2f
        canvas.drawText("OCTAVE", octaveCenterX, btnOctaveDown.top + 30f, labelPaint.apply { textSize = 18f })
        canvas.drawText("C$currentOctave", octaveCenterX, btnOctaveDown.bottom - 10f, textPaint.apply { textSize = 38f })

        canvas.drawRoundRect(btnOctaveUp, 12f, 12f, buttonPaint)
        canvas.drawRoundRect(btnOctaveUp, 12f, 12f, borderPaint)
        canvas.drawText("+", btnOctaveUp.centerX(), btnOctaveUp.centerY() + 15f, textPaint.apply { textSize = 50f })

        // Pitch Bend
        canvas.drawRoundRect(rectPitchBend, 10f, 10f, ribbonBgPaint)
        canvas.drawRoundRect(rectPitchBend, 10f, 10f, borderPaint)
        val pbPercentage = (pitchBendValue - 0).toFloat() / 16383f
        val pbX = rectPitchBend.left + (rectPitchBend.width() * pbPercentage)
        val pbIndicatorRect = RectF(pbX - 8f, rectPitchBend.top + 4f, pbX + 8f, rectPitchBend.bottom - 4f)
        canvas.drawRoundRect(pbIndicatorRect, 4f, 4f, ribbonFillPaint)
        canvas.drawText("PITCH BEND", rectPitchBend.centerX(), rectPitchBend.bottom - 15f, labelPaint.apply { textSize = 20f })

        // Modulation
        canvas.drawRoundRect(rectModulation, 10f, 10f, ribbonBgPaint)
        canvas.drawRoundRect(rectModulation, 10f, 10f, borderPaint)
        val modPercentage = modulationValue.toFloat() / 127f
        val modX = rectModulation.left + (rectModulation.width() * modPercentage)
        val modBarRect = RectF(rectModulation.left + 4f, rectModulation.top + 4f, modX, rectModulation.bottom - 4f)
        canvas.drawRoundRect(modBarRect, 6f, 6f, ribbonFillPaint.apply { alpha = 130 })
        
        val modIndicatorLine = RectF(modX - 5f, rectModulation.top + 4f, modX + 5f, rectModulation.bottom - 4f)
        canvas.drawRoundRect(modIndicatorLine, 3f, 3f, ribbonFillPaint.apply { alpha = 255 })
        canvas.drawText("MODULATION", rectModulation.centerX(), rectModulation.bottom - 15f, labelPaint.apply { textSize = 20f })

        // Sustain
        val sustColor = if (isSustainActive) buttonActivePaint else buttonPaint
        canvas.drawRoundRect(btnSustain, 12f, 12f, sustColor)
        canvas.drawRoundRect(btnSustain, 12f, 12f, borderPaint)
        canvas.drawText("SUSTAIN", btnSustain.centerX(), btnSustain.centerY() - 5f, labelPaint.apply { textSize = 20f })
        canvas.drawText(if (isSustainActive) "HOLD" else "OFF", btnSustain.centerX(), btnSustain.centerY() + 25f, textPaint.apply { textSize = 26f })

        // Velocity Mode
        canvas.drawRoundRect(btnVelocity, 12f, 12f, buttonPaint)
        canvas.drawRoundRect(btnVelocity, 12f, 12f, borderPaint)
        canvas.drawText("VELOCITY", btnVelocity.centerX(), btnVelocity.centerY() - 5f, labelPaint.apply { textSize = 20f })
        canvas.drawText(if (isDynamicVelocity) "DYNAMIC" else "FIXED 100", btnVelocity.centerX(), btnVelocity.centerY() + 25f, textPaint.apply { textSize = 22f })
    }

    private fun drawKeyboard(canvas: Canvas) {
        val yOffset = keyboardRect.top

        for (i in 0 until totalWhiteKeys) {
            val keyLeft = i * whiteKeyWidth
            val keyRight = keyLeft + whiteKeyWidth
            val keyRect = RectF(keyLeft, yOffset, keyRight, height.toFloat())
            val scaleNote = whiteKeySemitones[i]
            val midiNote = getMidiNoteNumber(scaleNote)

            val paint = if (currentlyPressedNotes.contains(midiNote)) whiteKeyActivePaint else whiteKeyPaint
            canvas.drawRect(keyRect, paint)
            canvas.drawRect(keyRect, whiteKeyBorderPaint)
        }

        for (i in blackKeyWhiteParentIndices.indices) {
            val parentIdx = blackKeyWhiteParentIndices[i]
            val semitone = blackKeySemitones[i]
            val midiNote = getMidiNoteNumber(semitone)

            val parentLeft = parentIdx * whiteKeyWidth
            val keyLeft = parentLeft + whiteKeyWidth - (blackKeyWidth / 2f)
            val keyRight = keyLeft + blackKeyWidth
            val keyRect = RectF(keyLeft, yOffset, keyRight, yOffset + blackKeyHeight)

            val paint = if (currentlyPressedNotes.contains(midiNote)) blackKeyActivePaint else blackKeyPaint
            canvas.drawRect(keyRect, paint)
        }
    }

    private fun getMidiNoteNumber(semitone: Int): Int {
        return (currentOctave + 1) * 12 + semitone
    }

    fun setBleConnectionStatus(connected: Boolean, deviceName: String?) {
        this.isBleConnected = connected
        this.bleDeviceName = deviceName
        postInvalidate()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val pointerCount = event.pointerCount
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val actionIndex = event.actionIndex
                val pointerId = event.getPointerId(actionIndex)
                val x = event.getX(actionIndex)
                val y = event.getY(actionIndex)
                handleTouchStart(pointerId, x, y)
            }
            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until pointerCount) {
                    val pointerId = event.getPointerId(i)
                    val x = event.getX(i)
                    val y = event.getY(i)
                    handleTouchMove(pointerId, x, y)
                }
            }
            MotionEvent.ACTION_POINTER_UP -> {
                val actionIndex = event.actionIndex
                val pointerId = event.getPointerId(actionIndex)
                handleTouchRelease(pointerId)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                val keysToRelease = activeTouches.keys.toList()
                for (pid in keysToRelease) {
                    handleTouchRelease(pid)
                }
                activeTouches.clear()
            }
        }
        postInvalidate()
        return true
    }

    private fun handleTouchStart(pointerId: Int, x: Float, y: Float) {
        val activeTouch = ActiveTouch()
        activeTouches[pointerId] = activeTouch

        if (y < navRect.bottom) {
            if (btnOctaveDown.contains(x, y)) {
                if (currentOctave > 1) {
                    currentOctave--
                    eventListener?.onOctaveChanged(currentOctave)
                    releaseAllActiveNotes()
                }
            } else if (btnOctaveUp.contains(x, y)) {
                if (currentOctave < 7) {
                    currentOctave++
                    eventListener?.onOctaveChanged(currentOctave)
                    releaseAllActiveNotes()
                }
            } else if (btnSustain.contains(x, y)) {
                isSustainActive = !isSustainActive
                eventListener?.onSustainChanged(isSustainActive)
                eventListener?.onControlChange(64, if (isSustainActive) 127 else 0)
            } else if (btnVelocity.contains(x, y)) {
                isDynamicVelocity = !isDynamicVelocity
                eventListener?.onVelocityToggleChanged(isDynamicVelocity)
            } else if (rectPitchBend.contains(x, y)) {
                activeTouch.touchType = TouchType.PITCH_BEND
                activeTouch.ribbonId = 0
                updatePitchBend(x)
            } else if (rectModulation.contains(x, y)) {
                activeTouch.touchType = TouchType.MODULATION
                activeTouch.ribbonId = 1
                updateModulation(x)
            }
        } else {
            activeTouch.touchType = TouchType.PIANO_KEY
            val noteCode = getNoteAtCoordinate(x, y)
            if (noteCode != -1) {
                activeTouch.noteTriggered = noteCode
                val velocity = calculateVelocity(y)
                triggerNoteOn(noteCode, velocity)
            }
        }
    }

    private fun handleTouchMove(pointerId: Int, x: Float, y: Float) {
        val activeTouch = activeTouches[pointerId] ?: return
        when (activeTouch.touchType) {
            TouchType.PITCH_BEND -> updatePitchBend(x)
            TouchType.MODULATION -> updateModulation(x)
            TouchType.PIANO_KEY -> {
                val currentMidiNote = getNoteAtCoordinate(x, y)
                if (currentMidiNote != -1 && currentMidiNote != activeTouch.noteTriggered) {
                    triggerNoteOff(activeTouch.noteTriggered)
                    activeTouch.noteTriggered = currentMidiNote
                    val velocity = calculateVelocity(y)
                    triggerNoteOn(currentMidiNote, velocity)
                }
            }
            else -> {}
        }
    }

    private fun handleTouchRelease(pointerId: Int) {
        val activeTouch = activeTouches.remove(pointerId) ?: return
        when (activeTouch.touchType) {
            TouchType.PIANO_KEY -> {
                if (activeTouch.noteTriggered != -1) {
                    triggerNoteOff(activeTouch.noteTriggered)
                }
            }
            TouchType.PITCH_BEND -> {
                pitchBendValue = 8192
                eventListener?.onPitchBend(pitchBendValue)
            }
            else -> {}
        }
    }

    private fun updatePitchBend(x: Float) {
        val width = rectPitchBend.width()
        val relativeX = (x - rectPitchBend.left).coerceIn(0f, width)
        val ratio = relativeX / width
        pitchBendValue = (ratio * 16383).toInt()
        eventListener?.onPitchBend(pitchBendValue)
    }

    private fun updateModulation(x: Float) {
        val width = rectModulation.width()
        val relativeX = (x - rectModulation.left).coerceIn(0f, width)
        val ratio = relativeX / width
        modulationValue = (ratio * 127).toInt()
        eventListener?.onControlChange(1, modulationValue)
    }

    private fun getNoteAtCoordinate(x: Float, y: Float): Int {
        if (y < keyboardRect.top) return -1
        val localY = y - keyboardRect.top
        if (localY < blackKeyHeight) {
            for (i in blackKeyWhiteParentIndices.indices) {
                val parentIdx = blackKeyWhiteParentIndices[i]
                val parentLeft = parentIdx * whiteKeyWidth
                val keyLeft = parentLeft + whiteKeyWidth - (blackKeyWidth / 2f)
                val keyRight = keyLeft + blackKeyWidth
                if (x >= keyLeft && x <= keyRight) {
                    return getMidiNoteNumber(blackKeySemitones[i])
                }
            }
        }
        val whiteKeyIndex = (x / whiteKeyWidth).toInt().coerceIn(0, totalWhiteKeys - 1)
        return getMidiNoteNumber(whiteKeySemitones[whiteKeyIndex])
    }

    private fun calculateVelocity(y: Float): Int {
        if (!isDynamicVelocity) return 100
        val rangeStart = keyboardRect.top
        val rangeHeight = keyboardRect.height()
        val relativeY = (y - rangeStart).coerceIn(0f, rangeHeight)
        val percentage = relativeY / rangeHeight
        return (64 + (percentage * 63)).toInt()
    }

    private fun triggerNoteOn(noteCode: Int, velocity: Int) {
        if (currentlyPressedNotes.add(noteCode)) {
            eventListener?.onNoteOn(noteCode, velocity)
        }
    }

    private fun triggerNoteOff(noteCode: Int) {
        if (currentlyPressedNotes.remove(noteCode)) {
            eventListener?.onNoteOff(noteCode)
        }
    }

    private fun releaseAllActiveNotes() {
        val activeCopy = HashSet(currentlyPressedNotes)
        for (note in activeCopy) {
            triggerNoteOff(note)
        }
        currentlyPressedNotes.clear()
    }
}`
  },
  {
    name: "AndroidManifest.xml",
    path: "android/app/src/main/AndroidManifest.xml",
    language: "xml",
    description: "Declares mandatory app permissions (including runtime BLE advertising and GATT connection permissions for Android S+), limits layout locks to landscape orientation, and registers the system's inbound/outbound MIDI device service.",
    code: `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.mobmidi.controller">

    <!-- Permissions for BLE and General Audio Services -->
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />

    <!-- Android 12+ (API 31+) dedicated Bluetooth Permissions -->
    <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" />

    <!-- Feature Declarations -->
    <uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
    <uses-feature android:name="android.software.midi" android:required="true" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="MobMidi Controller"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.NoTitleBar.Fullscreen">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:screenOrientation="landscape"
            android:configChanges="orientation|screenSize|keyboardHidden">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <service
            android:name="android.media.midi.MidiDeviceService"
            android:permission="android.permission.BIND_MIDI_DEVICE_SERVICE"
            android:exported="true">
            <intent-filter>
                <action android:name="android.media.midi.MidiDeviceService" />
            </intent-filter>
            <meta-data
                android:name="android.media.midi.MidiDeviceService"
                android:resource="@xml/midi_device_info" />
        </service>

    </application>
</manifest>`
  },
  {
    name: "midi_device_info.xml",
    path: "android/app/src/main/res/xml/midi_device_info.xml",
    language: "xml",
    description: "MIDI Device Service capability profile containing target manufacturer details, product title, and physical port assignments for routing real-time notes.",
    code: `<?xml version="1.0" encoding="utf-8"?>
<devices xmlns:android="http://schemas.android.com/apk/res/android">
    <device manufacturer="MobMidi Inc" product="MobMidi BLE Controller" name="MobMidi Controller">
        <!-- 
          Android MIDI Port Mappings.
          Reports MIDI events triggered on the custom board keys 
          to connected host targets like macOS/iOS DAWs.
        -->
        <input-port name="input" />
        <output-port name="output" />
    </device>
</devices>`
  },
  {
    name: "build.gradle",
    path: "android/app/build.gradle",
    language: "gradle",
    description: "App module configuration specifying compilation targets (Oreo SDK 26 to SDK 34), optimizing Kotlin JVM build parameters, and importing the material layout dependencies.",
    code: `plugins {
    id 'com.android.application'
    id 'org.jetbrains.kotlin.android'
}

android {
    namespace 'com.mobmidi.controller'
    compileSdk 34

    defaultConfig {
        applicationId "com.mobmidi.controller"
        minSdk 26
        targetSdk 34
        versionCode 1
        versionName "1.0"
    }

    buildTypes {
        release {
            minifyEnabled true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
            signingConfig signingConfigs.debug
        }
    }

    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = '17'
        freeCompilerArgs += ["-Xopt-in=kotlin.RequiresOptIn"]
    }
}

dependencies {
    implementation 'androidx.core:core-ktx:1.12.0'
    implementation 'androidx.appcompat:appcompat:1.6.1'
    implementation 'com.google.android.material:material:1.11.0'
}`
  }
];
