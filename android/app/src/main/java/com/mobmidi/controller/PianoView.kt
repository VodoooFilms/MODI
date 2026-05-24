package com.mobmidi.controller

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * A Custom View that renders the professional BLE MIDI controller interface.
 * Implements a top control bar (20%) and a multi-touch keyboard (80%) of 1.5 octaves.
 * Optimized with custom Canvas drawing for absolute minimum input latency.
 */
class PianoView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    // Listener for routing UI control inputs and MIDI notes to parent activity
    interface MidiEventListener {
        fun onNoteOn(noteCode: Int, velocity: Int)
        fun onNoteOff(noteCode: Int)
        fun onPitchBend(value: Int) // 0 - 16383 (center 8192)
        fun onControlChange(control: Int, value: Int) // CC#1 Mod or CC#64 Sustain
        fun onSustainChanged(isSustainOn: Boolean)
        fun onVelocityToggleChanged(isDynamic: Boolean)
        fun onOctaveChanged(newOctave: Int)
    }

    private var eventListener: MidiEventListener? = null
    fun setMidiEventListener(listener: MidiEventListener) {
        this.eventListener = listener
    }

    // --- State Variables ---
    private var isBleConnected = false
    private var bleDeviceName: String? = null
    private var currentOctave = 3 // Standard center octave C3
    private var isSustainActive = false
    private var isDynamicVelocity = true
    
    private var pitchBendValue = 8192 // Center 14-bit pitch bend
    private var modulationValue = 0 // CC#1 Mod
    
    // Track pointer touches to recognize what they are holding
    private class ActiveTouch {
        var touchType: TouchType = TouchType.NONE
        var noteTriggered: Int = -1
        var ribbonId: Int = -1 // 0 for Pitch Bend, 1 for Modulation
    }
    
    private enum class TouchType {
        NONE, PIANO_KEY, PITCH_BEND, MODULATION
    }
    
    // Multi-touch tracking maps: maps pointerId to its active touch state
    private val activeTouches = HashMap<Int, ActiveTouch>()
    
    // Track currently sounding MIDI notes for drawing, plus per-note hold counts for multi-touch correctness
    private val currentlyPressedNotes = HashSet<Int>()
    private val noteHoldCounts = HashMap<Int, Int>()

    // --- Aesthetic Paints ---
    private val bgPaint = Paint().apply { color = Color.parseColor("#0B1020"); style = Paint.Style.FILL }
    private val navPanelPaint = Paint().apply { style = Paint.Style.FILL }
    private val navPanelGlowPaint = Paint().apply { style = Paint.Style.FILL; isAntiAlias = true }
    private val whiteKeyPaint = Paint().apply { color = Color.WHITE; style = Paint.Style.FILL }
    private val whiteKeyBorderPaint = Paint().apply { color = Color.parseColor("#D7DCE5"); style = Paint.Style.STROKE; strokeWidth = 2f }
    private val whiteKeyActivePaint = Paint().apply { color = Color.parseColor("#B8E1FF"); style = Paint.Style.FILL }
    
    private val blackKeyPaint = Paint().apply { color = Color.parseColor("#111827"); style = Paint.Style.FILL }
    private val blackKeyActivePaint = Paint().apply { color = Color.parseColor("#38BDF8"); style = Paint.Style.FILL }
    
    private val ledConnectedPaint = Paint().apply { color = Color.parseColor("#38BDF8"); isAntiAlias = true }
    private val ledDisconnectedPaint = Paint().apply { color = Color.parseColor("#EF4444"); isAntiAlias = true } // Red
    private val ledGlowPaint = Paint().apply { isAntiAlias = true; style = Paint.Style.FILL }
    
    private val textPaint = Paint().apply { color = Color.WHITE; textSize = 40f; isAntiAlias = true; textAlign = Paint.Align.CENTER }
    private val valuePaint = Paint().apply { color = Color.parseColor("#F8FAFC"); textSize = 32f; isAntiAlias = true; textAlign = Paint.Align.CENTER }
    private val labelPaint = Paint().apply { color = Color.parseColor("#94A3B8"); textSize = 26f; isAntiAlias = true; textAlign = Paint.Align.CENTER }
    
    private val buttonPaint = Paint().apply { color = Color.parseColor("#162033"); style = Paint.Style.FILL }
    private val buttonActivePaint = Paint().apply { color = Color.parseColor("#1D3557"); style = Paint.Style.FILL }
    private val borderPaint = Paint().apply { color = Color.parseColor("#334155"); style = Paint.Style.STROKE; strokeWidth = 2.5f }
    private val accentBorderPaint = Paint().apply { color = Color.parseColor("#38BDF8"); style = Paint.Style.STROKE; strokeWidth = 2.5f; alpha = 140 }
    
    private val ribbonBgPaint = Paint().apply { color = Color.parseColor("#101827"); style = Paint.Style.FILL }
    private val ribbonFillPaint = Paint().apply { color = Color.parseColor("#0EA5E9"); style = Paint.Style.FILL }
    private val ribbonTrackPaint = Paint().apply { color = Color.parseColor("#1E293B"); style = Paint.Style.FILL }
    private val shadowPaint = Paint().apply { color = Color.parseColor("#020617"); style = Paint.Style.FILL; alpha = 90 }

    // Rectangle boundaries for interactive UI elements
    private var navRect = RectF()
    private var keyboardRect = RectF()
    
    private var btnOctaveDown = RectF()
    private var btnOctaveUp = RectF()
    private var btnSustain = RectF()
    private var btnVelocity = RectF()
    private var rectPitchBend = RectF()
    private var rectModulation = RectF()
    
    // Keyboard layouts
    private val totalWhiteKeys = 11 // exactly 1.5 Octaves: C, D, E, F, G, A, B, C, D, E, F
    private var whiteKeyWidth = 0f
    private var blackKeyWidth = 0f
    private var blackKeyHeight = 0f

    // Scale mappings (relative semitones from C)
    private val whiteKeySemitones = intArrayOf(0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17)
    // Black keys position offsets of white key (e.g. key 0 has black key at its right, key 1 has black key at its right, none for key 2, etc.)
    private val blackKeyWhiteParentIndices = intArrayOf(0, 1, 3, 4, 5, 7, 8)
    private val blackKeySemitones = intArrayOf(1, 3, 6, 8, 10, 13, 15)

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val width = w.toFloat()
        val height = h.toFloat()

        // 20% Top Control/NavBar, 80% Bottom Keyboard
        val navHeight = height * 0.20f
        navRect.set(0f, 0f, width, navHeight)
        keyboardRect.set(0f, navHeight, width, height)

        // Segment Nav Controls
        val padding = 15f
        val topY = padding
        val bottomY = navHeight - padding

        // Elements from left to right:
        // LED Connection Console -> Octave [- / +] -> Pitch Bend Ribbon -> Modulation Ribbon -> Sustain -> Velocity
        // Octave Section
        val btnW = (width * 0.06f).coerceAtLeast(60f)
        val octaveCenterX = width * 0.22f
        btnOctaveDown.set(octaveCenterX - btnW - 30f, topY, octaveCenterX - 30f, bottomY)
        btnOctaveUp.set(octaveCenterX + 30f, topY, octaveCenterX + btnW + 30f, bottomY)

        // Ribbons Section (Pitch Bend & Modulation Ribbons)
        val ribbonStart = width * 0.35f
        val ribbonEnd = width * 0.68f
        val totalRibbonWidth = ribbonEnd - ribbonStart
        val ribbonW = totalRibbonWidth / 2f
        
        rectPitchBend.set(ribbonStart, topY + 5f, ribbonStart + ribbonW - 15f, bottomY - 5f)
        rectModulation.set(ribbonStart + ribbonW + 15f, topY + 5f, ribbonEnd, bottomY - 5f)

        // Utility Buttons (Sustain & Velocity Toggle)
        val utilStart = width * 0.72f
        val utilWidth = (width - utilStart) / 2f - padding
        
        btnSustain.set(utilStart, topY, utilStart + utilWidth, bottomY)
        btnVelocity.set(utilStart + utilWidth + padding, topY, width - padding, bottomY)

        // Keyboard layouts
        whiteKeyWidth = width / totalWhiteKeys
        blackKeyWidth = whiteKeyWidth * 0.58f
        blackKeyHeight = (height - navHeight) * 0.58f

        navPanelPaint.shader = LinearGradient(
            0f,
            navRect.top,
            width,
            navRect.bottom,
            intArrayOf(
                Color.parseColor("#101726"),
                Color.parseColor("#0F172A"),
                Color.parseColor("#0A1220")
            ),
            floatArrayOf(0f, 0.55f, 1f),
            Shader.TileMode.CLAMP
        )
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)

        drawNavBar(canvas)
        drawKeyboard(canvas)
    }

    private fun drawNavBar(canvas: Canvas) {
        val navHeight = navRect.height()
        val titleY = navRect.top + navHeight * 0.42f
        val valueY = navRect.top + navHeight * 0.74f
        val ribbonLabelY = navRect.top + navHeight * 0.82f
        val panelRect = RectF(10f, 10f, width - 10f, navRect.bottom - 6f)

        navPanelGlowPaint.color = Color.parseColor("#082F49")
        navPanelGlowPaint.alpha = 45
        canvas.drawRoundRect(RectF(panelRect.left, panelRect.top, panelRect.right, panelRect.bottom + 6f), 24f, 24f, navPanelGlowPaint)
        canvas.drawRoundRect(panelRect, 22f, 22f, navPanelPaint)
        canvas.drawRoundRect(panelRect, 22f, 22f, borderPaint)

        // 1. Connection LED Draw
        val ledX = width * 0.05f
        val ledY = navRect.centerY()
        val ledRadius = 14f

        ledGlowPaint.color = if (isBleConnected) Color.parseColor("#3B82F6") else Color.parseColor("#EF4444")
        ledGlowPaint.alpha = 50
        canvas.drawCircle(ledX, ledY, ledRadius + 10f, ledGlowPaint)
        
        val ledSolidPaint = if (isBleConnected) ledConnectedPaint else ledDisconnectedPaint
        canvas.drawCircle(ledX, ledY, ledRadius, ledSolidPaint)

        // Text below LED
        val subText = if (isBleConnected) (bleDeviceName ?: "CONN") else "BLE MIDI"
        canvas.drawText(subText, ledX, valueY, labelPaint.apply { textSize = 20f })

        // 2. Octave shift (-) and (+) buttons and display
        // Octave [-] button
        canvas.drawRoundRect(RectF(btnOctaveDown.left, btnOctaveDown.top + 4f, btnOctaveDown.right, btnOctaveDown.bottom + 4f), 12f, 12f, shadowPaint)
        canvas.drawRoundRect(btnOctaveDown, 12f, 12f, buttonPaint)
        canvas.drawRoundRect(btnOctaveDown, 12f, 12f, borderPaint)
        canvas.drawText("-", btnOctaveDown.centerX(), btnOctaveDown.centerY() + 15f, textPaint.apply { textSize = 50f })

        // Current Octave visual display in the center of buttons
        val octaveCenterX = (btnOctaveDown.right + btnOctaveUp.left) / 2f
        canvas.drawText("OCTAVE", octaveCenterX, titleY, labelPaint.apply {
            textSize = 18f
            textAlign = Paint.Align.CENTER
        })
        canvas.drawText("C$currentOctave", octaveCenterX, valueY, valuePaint.apply { textSize = 30f })

        // Octave [+] button
        canvas.drawRoundRect(RectF(btnOctaveUp.left, btnOctaveUp.top + 4f, btnOctaveUp.right, btnOctaveUp.bottom + 4f), 12f, 12f, shadowPaint)
        canvas.drawRoundRect(btnOctaveUp, 12f, 12f, buttonPaint)
        canvas.drawRoundRect(btnOctaveUp, 12f, 12f, borderPaint)
        canvas.drawText("+", btnOctaveUp.centerX(), btnOctaveUp.centerY() + 15f, textPaint.apply { textSize = 50f })

        // 3. Pitch Bend Ribbon (0 - 16383)
        canvas.drawRoundRect(RectF(rectPitchBend.left, rectPitchBend.top + 4f, rectPitchBend.right, rectPitchBend.bottom + 4f), 10f, 10f, shadowPaint)
        canvas.drawRoundRect(rectPitchBend, 10f, 10f, ribbonBgPaint)
        canvas.drawRoundRect(rectPitchBend, 10f, 10f, borderPaint)
        canvas.drawRoundRect(RectF(rectPitchBend.left + 6f, rectPitchBend.centerY() - 3f, rectPitchBend.right - 6f, rectPitchBend.centerY() + 3f), 4f, 4f, ribbonTrackPaint)
        
        // Draw relative horizontal slider line or bar for Pitch Bend
        val pbPercentage = (pitchBendValue - 0).toFloat() / 16383f
        val pbX = rectPitchBend.left + (rectPitchBend.width() * pbPercentage)
        val fillWidth = 8f
        val pbIndicatorRect = RectF(pbX - fillWidth, rectPitchBend.top + 4f, pbX + fillWidth, rectPitchBend.bottom - 4f)
        canvas.drawRoundRect(pbIndicatorRect, 4f, 4f, ribbonFillPaint)
        canvas.drawText("PITCH BEND", rectPitchBend.centerX(), ribbonLabelY, labelPaint.apply {
            textSize = 17f
            textAlign = Paint.Align.CENTER
        })

        // 4. Modulation Ribbon
        canvas.drawRoundRect(RectF(rectModulation.left, rectModulation.top + 4f, rectModulation.right, rectModulation.bottom + 4f), 10f, 10f, shadowPaint)
        canvas.drawRoundRect(rectModulation, 10f, 10f, ribbonBgPaint)
        canvas.drawRoundRect(rectModulation, 10f, 10f, borderPaint)
        
        // Draw Modulation indicator bar
        val modPercentage = modulationValue.toFloat() / 127f
        val modX = rectModulation.left + (rectModulation.width() * modPercentage)
        val modBarRect = RectF(rectModulation.left + 4f, rectModulation.top + 4f, modX, rectModulation.bottom - 4f)
        canvas.drawRoundRect(modBarRect, 6f, 6f, ribbonFillPaint.apply { alpha = 130 })
        
        val modIndicatorLine = RectF(modX - 5f, rectModulation.top + 4f, modX + 5f, rectModulation.bottom - 4f)
        canvas.drawRoundRect(modIndicatorLine, 3f, 3f, ribbonFillPaint.apply { alpha = 255 })
        canvas.drawText("MODULATION", rectModulation.centerX(), ribbonLabelY, labelPaint.apply {
            textSize = 17f
            textAlign = Paint.Align.CENTER
        })

        // 5. Sustain pedal Toggle
        val sustColor = if (isSustainActive) buttonActivePaint else buttonPaint
        canvas.drawRoundRect(RectF(btnSustain.left, btnSustain.top + 4f, btnSustain.right, btnSustain.bottom + 4f), 12f, 12f, shadowPaint)
        canvas.drawRoundRect(btnSustain, 12f, 12f, sustColor)
        canvas.drawRoundRect(btnSustain, 12f, 12f, if (isSustainActive) accentBorderPaint else borderPaint)
        canvas.drawText("SUSTAIN", btnSustain.centerX(), titleY, labelPaint.apply {
            textSize = 18f
            textAlign = Paint.Align.CENTER
        })
        canvas.drawText(if (isSustainActive) "HOLD" else "OFF", btnSustain.centerX(), valueY, valuePaint.apply { textSize = 23f })

        // 6. Velocity Mode Button
        canvas.drawRoundRect(RectF(btnVelocity.left, btnVelocity.top + 4f, btnVelocity.right, btnVelocity.bottom + 4f), 12f, 12f, shadowPaint)
        canvas.drawRoundRect(btnVelocity, 12f, 12f, buttonPaint)
        canvas.drawRoundRect(btnVelocity, 12f, 12f, if (isDynamicVelocity) accentBorderPaint else borderPaint)
        canvas.drawText("VELOCITY", btnVelocity.centerX(), titleY, labelPaint.apply {
            textSize = 18f
            textAlign = Paint.Align.CENTER
        })
        canvas.drawText(if (isDynamicVelocity) "DYNAMIC" else "FIXED 100", btnVelocity.centerX(), valueY, valuePaint.apply { textSize = 20f })
    }

    private fun drawKeyboard(canvas: Canvas) {
        val yOffset = keyboardRect.top

        // Draw white keys first
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

        // Draw black keys on top
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
        // Base MIDI octave (currentOctave + 1) * 12
        return (currentOctave + 1) * 12 + semitone
    }

    // Bluetooth Connection update hooks for parent callback
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
                // ACTION_MOVE coordinates updates for some or all ongoing tracking pointers
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
                // Clear all tracking
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

        // Decide: Control Navbar vs Piano Keyboard
        if (y < navRect.bottom) {
            // Check button triggers inside Navbar
            if (btnOctaveDown.contains(x, y)) {
                if (currentOctave > 1) {
                    currentOctave--
                    eventListener?.onOctaveChanged(currentOctave)
                    // Release any stuck notes since the active transpose scale shifted
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
            // Piano Keyboard triggers
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
            TouchType.PITCH_BEND -> {
                updatePitchBend(x)
            }
            TouchType.MODULATION -> {
                updateModulation(x)
            }
            TouchType.PIANO_KEY -> {
                val currentMidiNote = getNoteAtCoordinate(x, y)
                if (currentMidiNote == activeTouch.noteTriggered) {
                    return
                }

                if (activeTouch.noteTriggered != -1) {
                    triggerNoteOff(activeTouch.noteTriggered)
                    activeTouch.noteTriggered = -1
                }

                if (currentMidiNote != -1) {
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
                // Auto-return Pitch Bend to absolute center configuration (8192)
                pitchBendValue = 8192
                eventListener?.onPitchBend(pitchBendValue)
            }
            TouchType.MODULATION -> {
                // Hold value - do nothing to the modulationValue! Its state persists.
            }
            else -> {}
        }
    }

    private fun updatePitchBend(x: Float) {
        val width = rectPitchBend.width()
        val relativeX = (x - rectPitchBend.left).coerceIn(0f, width)
        val ratio = relativeX / width // 0.0 to 1.0
        val centered = ((ratio - 0.5f) * 2f).coerceIn(-1f, 1f)
        val shaped = shapeCenteredControl(centered, exponent = 0.68f)
        val normalized = ((shaped + 1f) * 0.5f).coerceIn(0f, 1f)
        pitchBendValue = (normalized * 16383f).toInt()
        eventListener?.onPitchBend(pitchBendValue)
    }

    private fun updateModulation(x: Float) {
        val width = rectModulation.width()
        val relativeX = (x - rectModulation.left).coerceIn(0f, width)
        val ratio = relativeX / width // 0.0 to 1.0
        val shaped = ratio.toDouble().pow(0.7).toFloat().coerceIn(0f, 1f)
        modulationValue = (shaped * 127f).toInt()
        eventListener?.onControlChange(1, modulationValue)
    }

    private fun shapeCenteredControl(value: Float, exponent: Float): Float {
        val magnitude = abs(value).toDouble().pow(exponent.toDouble()).toFloat()
        return if (value < 0f) -magnitude else magnitude
    }

    /**
     * Determines what note exists at an absolute (X, Y) layout position.
     * Evaluates black keys overlays first because they overlap white keys.
     */
    private fun getNoteAtCoordinate(x: Float, y: Float): Int {
        if (x < 0f || x > width.toFloat() || y < keyboardRect.top || y > height.toFloat()) return -1
        
        val localY = y - keyboardRect.top

        // 1. Evaluate top vertical zone for black keys triggers overlay
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

        // 2. Evaluate white keys
        val whiteKeyIndex = (x / whiteKeyWidth).toInt().coerceIn(0, totalWhiteKeys - 1)
        return getMidiNoteNumber(whiteKeySemitones[whiteKeyIndex])
    }

    private fun calculateVelocity(y: Float): Int {
        if (!isDynamicVelocity) return 100 // FIXED speed index
        
        // Dynamic: bottom space = 127, top space = 64
        val rangeStart = keyboardRect.top
        val rangeHeight = keyboardRect.height()
        val relativeY = (y - rangeStart).coerceIn(0f, rangeHeight)
        val percentage = relativeY / rangeHeight // 0.0 (top) to 1.0 (bottom)
        
        return (64 + (percentage * 63)).toInt() // Scale from 64 to 127
    }

    private fun triggerNoteOn(noteCode: Int, velocity: Int) {
        val holdCount = noteHoldCounts.getOrDefault(noteCode, 0) + 1
        noteHoldCounts[noteCode] = holdCount

        if (holdCount == 1) {
            currentlyPressedNotes.add(noteCode)
            eventListener?.onNoteOn(noteCode, velocity)
        }
    }

    private fun triggerNoteOff(noteCode: Int) {
        val holdCount = noteHoldCounts[noteCode] ?: return
        if (holdCount > 1) {
            noteHoldCounts[noteCode] = holdCount - 1
            return
        }

        noteHoldCounts.remove(noteCode)
        if (currentlyPressedNotes.remove(noteCode)) {
            eventListener?.onNoteOff(noteCode)
        }
    }

    private fun releaseAllActiveNotes() {
        val activeCopy = HashSet(currentlyPressedNotes)
        for (note in activeCopy) {
            eventListener?.onNoteOff(note)
        }
        currentlyPressedNotes.clear()
        noteHoldCounts.clear()

        for (touch in activeTouches.values) {
            if (touch.touchType == TouchType.PIANO_KEY) {
                touch.noteTriggered = -1
            }
        }
    }
}
