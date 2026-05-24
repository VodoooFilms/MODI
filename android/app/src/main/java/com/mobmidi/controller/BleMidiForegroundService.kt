package com.mobmidi.controller

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the BLE MIDI peripheral alive independently from the Activity lifecycle.
 */
class BleMidiForegroundService : Service(), MidiBleManager.ConnectionStatusListener {

    companion object {
        private const val NOTIFICATION_CHANNEL_ID = "mobmidi_ble_channel"
        private const val NOTIFICATION_ID = 1001
    }

    inner class LocalBinder : Binder() {
        fun getService(): BleMidiForegroundService = this@BleMidiForegroundService
    }

    private val binder = LocalBinder()
    private lateinit var midiBleManager: MidiBleManager
    private var connectionStatusListener: MidiBleManager.ConnectionStatusListener? = null
    private var isStarted = false
    private var lastTransportStatus = "Inicializando BLE MIDI"
    private var isConnected = false
    private var connectedDeviceName: String? = null

    override fun onCreate() {
        super.onCreate()
        midiBleManager = MidiBleManager(this, this)
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification(isConnected = false, deviceName = null))
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureStarted()
        return START_STICKY
    }

    override fun onDestroy() {
        midiBleManager.stop()
        super.onDestroy()
    }

    fun ensureStarted() {
        if (isStarted) return
        midiBleManager.start()
        isStarted = true
    }

    fun sendMidiEvent(status: Int, data1: Int, data2: Int) {
        ensureStarted()
        midiBleManager.sendMidiEvent(status, data1, data2)
    }

    fun setConnectionStatusListener(listener: MidiBleManager.ConnectionStatusListener?) {
        connectionStatusListener = listener
    }

    override fun onConnectionStatusChanged(isConnected: Boolean, deviceName: String?) {
        this.isConnected = isConnected
        connectedDeviceName = deviceName
        pushNotification()
        connectionStatusListener?.onConnectionStatusChanged(isConnected, deviceName)
    }

    override fun onTransportStateChanged(status: String) {
        lastTransportStatus = status
        pushNotification()
        connectionStatusListener?.onTransportStateChanged(status)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "MODI BLE",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Mantiene activo el controlador MIDI BLE de MODI"
        }

        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.createNotificationChannel(channel)
    }

    private fun buildNotification(isConnected: Boolean, deviceName: String?): Notification {
        val statusText = if (isConnected) {
            "Conectado a ${deviceName ?: "host BLE MIDI"}"
        } else {
            lastTransportStatus
        }

        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("MODI activo")
            .setContentText(statusText)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun pushNotification() {
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID, buildNotification(isConnected, connectedDeviceName))
    }
}
