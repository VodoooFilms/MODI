package com.mobmidi.controller

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.Toast

/**
 * Entry point of the MODI Android application.
 * Manages Permissions Flow, Bluetooth GATT server, and Low-Latency Native Audio Fallback.
 */
class MainActivity : Activity(), MidiBleManager.ConnectionStatusListener, PianoView.MidiEventListener {

    companion object {
        private const val TAG = "MainActivity"
        private const val PERMISSION_REQUEST_CODE = 101
        private const val SAMPLE_RATE = 44100
    }

    private lateinit var pianoView: PianoView
    private var bleService: BleMidiForegroundService? = null
    private var isServiceBound = false

    private val bleServiceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            val binder = service as? BleMidiForegroundService.LocalBinder ?: return
            bleService = binder.getService()
            bleService?.setConnectionStatusListener(this@MainActivity)
            bleService?.ensureStarted()
            isServiceBound = true
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            bleService?.setConnectionStatusListener(null)
            bleService = null
            isServiceBound = false
        }
    }



    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Lock landscape mode programmatically (if not declared in Manifest)
        requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Initialize Piano View as the full content view
        pianoView = PianoView(this)
        pianoView.setMidiEventListener(this)
        setContentView(pianoView)

        // Check & request Bluetooth / Location permissions
        if (checkPermissions()) {
            startBleServiceIfPermitted()
        } else {
            requestPermissions()
        }
    }

    override fun onResume() {
        super.onResume()
        if (isServiceBound) {
            bleService?.setConnectionStatusListener(this)
        }
        startBleServiceIfPermitted()
    }

    override fun onPause() {
        bleService?.setConnectionStatusListener(null)
        super.onPause()
    }

    override fun onDestroy() {
        if (isServiceBound) {
            unbindService(bleServiceConnection)
            isServiceBound = false
        }
        super.onDestroy()
    }



    // --- PianoView MidiEventListener Callbacks ---

    override fun onNoteOn(noteCode: Int, velocity: Int) {
        // Send BLE MIDI packet (Status byte for Note On is 0x90)
        // Default MIDI channel = 0 (so Note On status byte = 0x90 | 0x00)
        bleService?.sendMidiEvent(0x90, noteCode, velocity)
    }

    override fun onNoteOff(noteCode: Int) {
        // Send BLE MIDI packet (Status byte for Note Off is 0x80)
        bleService?.sendMidiEvent(0x80, noteCode, 0)
    }

    override fun onPitchBend(value: Int) {
        // Pitch Bend status byte = 0xE0
        // Sends 14-bit data split into two 7-bit bytes: low byte (bits 0-6), high byte (bits 7-13)
        val lsb = value and 0x7F
        val msb = (value shr 7) and 0x7F
        bleService?.sendMidiEvent(0xE0, lsb, msb)
    }

    override fun onControlChange(control: Int, value: Int) {
        // CC status byte = 0xB0
        bleService?.sendMidiEvent(0xB0, control, value)
    }

    override fun onSustainChanged(isSustainOn: Boolean) {
        // Handled in onControlChange (CC#64) on PianoView already, but logged here
        Log.d(TAG, "Sustain changed: $isSustainOn")
    }

    override fun onVelocityToggleChanged(isDynamic: Boolean) {
        Log.d(TAG, "Velocity dynamics changed: $isDynamic")
    }

    override fun onOctaveChanged(newOctave: Int) {
        Log.d(TAG, "Octave Shifted to: $newOctave")
    }

    // --- Connection Status callback from BLE GATT Server ---
    override fun onConnectionStatusChanged(isConnected: Boolean, deviceName: String?) {
        runOnUiThread {
            pianoView.setBleConnectionStatus(isConnected, deviceName)
            if (isConnected) {
                Toast.makeText(this, "BLE Host connected: $deviceName", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "BLE Disconnected", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onTransportStateChanged(status: String) {
        // Transport status is kept in the foreground notification; the in-app header stays minimal.
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
                startBleServiceIfPermitted()
                Toast.makeText(this, "BLE permissions successfully accepted.", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "BLE permissions denied. BLE MIDI will not function.", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun startBleServiceIfPermitted() {
        if (!::pianoView.isInitialized || !checkPermissions()) return

        val serviceIntent = Intent(this, BleMidiForegroundService::class.java)
        startForegroundService(serviceIntent)

        if (!isServiceBound) {
            bindService(serviceIntent, bleServiceConnection, Context.BIND_AUTO_CREATE)
        } else {
            bleService?.ensureStarted()
        }
    }
}
