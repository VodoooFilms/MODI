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
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

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

    private data class PadAssignment(
        val note: Int,
        val label: String,
        val channel: Int = 0
    )

    private data class FaderAssignment(
        val cc: Int,
        val label: String,
        val channel: Int = 0
    )

    private data class XYAssignment(
        val xCc: Int,
        val yCc: Int,
        val label: String,
        val channel: Int = 0
    )

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
    private var lastDispatchedPitchBendValue = 8192
    private var lastDispatchedModulationValue = 0
    private var currentScreen = ControllerScreen.PIANO
    private var isSettingsOpen = false
    private val drumRowLevels = intArrayOf(118, 104, 96)
    private val drumFxValues = intArrayOf(0, 32, 0, 18)
    private var hybridModXValue = 64
    private var hybridModYValue = 64
    private var lastDispatchedHybridModX = 64
    private var lastDispatchedHybridModY = 64
    
    // Track pointer touches to recognize what they are holding
    private class ActiveTouch {
        var touchType: TouchType = TouchType.NONE
        var noteTriggered: Int = -1
        var ribbonId: Int = -1 // 0 for Pitch Bend, 1 for Modulation
        var controlIndex: Int = -1
    }

    private enum class ControllerScreen {
        PIANO, DRUM_PADS, HYBRID_MOD
    }
    
    private enum class TouchType {
        NONE, PIANO_KEY, PITCH_BEND, MODULATION, DRUM_PAD, DRUM_LEVEL, DRUM_FX, HYBRID_PAD, HYBRID_XY
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
    private val settingsIconPaint = Paint().apply {
        color = Color.parseColor("#94A3B8")
        style = Paint.Style.STROKE
        strokeWidth = 3f
        isAntiAlias = true
    }
    
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
    private var btnSettings = RectF()
    private var rectPitchBend = RectF()
    private var rectModulation = RectF()
    private val settingsOverlayRect = RectF()
    private val settingsOptionRects = Array(3) { RectF() }
    private val drumLevelRects = Array(3) { RectF() }
    private val drumPadRects = Array(9) { RectF() }
    private val drumFxRects = Array(4) { RectF() }
    private val hybridPadRects = Array(6) { RectF() }
    private val hybridModRect = RectF()
    private val panelRect = RectF()
    private val tempRect = RectF()
    
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
    private val settingsTitles = arrayOf("PIANO", "DRUM PADS", "PADS + XY")
    private val settingsSubtitles = arrayOf("Keys and ribbons", "9 pads + row levels", "Pads with XY mod")
    private val drumRowLabels = arrayOf("A", "B", "C")
    private val drumPadAssignments = arrayOf(
        PadAssignment(36, "KICK"),
        PadAssignment(38, "SNARE"),
        PadAssignment(42, "HAT"),
        PadAssignment(39, "CLAP"),
        PadAssignment(41, "TOM"),
        PadAssignment(43, "RIM"),
        PadAssignment(45, "CRASH"),
        PadAssignment(47, "RIDE"),
        PadAssignment(49, "FX")
    )
    private val drumFxAssignments = arrayOf(
        FaderAssignment(74, "FILTER"),
        FaderAssignment(91, "REVERB"),
        FaderAssignment(94, "DELAY"),
        FaderAssignment(71, "DRIVE")
    )
    private val hybridPadAssignments = arrayOf(
        PadAssignment(48, "A1"),
        PadAssignment(50, "A2"),
        PadAssignment(52, "A3"),
        PadAssignment(53, "B1"),
        PadAssignment(55, "B2"),
        PadAssignment(57, "B3")
    )
    private val hybridXYAssignment = XYAssignment(
        xCc = 1,
        yCc = 74,
        label = "XY MOD"
    )

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
        val settingsAreaWidth = (width * 0.09f).coerceAtLeast(70f)
        val utilStart = width * 0.66f
        val utilEnd = width - padding - settingsAreaWidth - padding
        val utilWidth = ((utilEnd - utilStart - padding) / 2f).coerceAtLeast(70f)
        
        btnSustain.set(utilStart, topY, utilStart + utilWidth, bottomY)
        btnVelocity.set(utilStart + utilWidth + padding, topY, utilStart + (utilWidth * 2f) + padding, bottomY)
        btnSettings.set(width - padding - settingsAreaWidth, topY, width - padding, bottomY)

        // Keyboard layouts
        whiteKeyWidth = width / totalWhiteKeys
        blackKeyWidth = whiteKeyWidth * 0.58f
        blackKeyHeight = (height - navHeight) * 0.58f

        layoutSettingsOverlay()
        layoutDrumScreen()
        layoutHybridScreen()

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

    private fun layoutSettingsOverlay() {
        val overlayWidth = width * 0.56f
        val overlayHeight = keyboardRect.height() * 0.36f
        val left = (width - overlayWidth) * 0.5f
        val top = keyboardRect.top + keyboardRect.height() * 0.15f
        settingsOverlayRect.set(left, top, left + overlayWidth, top + overlayHeight)

        val optionGap = 18f
        val innerPadding = 22f
        val optionWidth = (overlayWidth - innerPadding * 2f - optionGap * 2f) / 3f
        val optionTop = top + overlayHeight * 0.38f
        val optionBottom = top + overlayHeight - 24f
        for (index in settingsOptionRects.indices) {
            val optionLeft = left + innerPadding + index * (optionWidth + optionGap)
            settingsOptionRects[index].set(optionLeft, optionTop, optionLeft + optionWidth, optionBottom)
        }
    }

    private fun layoutDrumScreen() {
        val contentTop = keyboardRect.top + 68f
        val contentBottom = height.toFloat() - 18f
        val contentLeft = 18f
        val contentRight = width.toFloat() - 18f
        val sliderWidth = ((contentRight - contentLeft) * 0.11f).coerceAtLeast(38f)
        val sliderGap = 12f
        val padGap = 14f
        val fxGap = 12f
        val fxColumnWidth = ((contentRight - contentLeft) * 0.12f).coerceAtLeast(54f)

        for (index in drumLevelRects.indices) {
            val left = contentLeft + index * (sliderWidth + sliderGap)
            drumLevelRects[index].set(left, contentTop, left + sliderWidth, contentBottom)
        }

        val padLeft = drumLevelRects.last().right + 26f
        val padTop = contentTop
        val fxLeft = contentRight - fxColumnWidth
        val padSize = min(
            (fxLeft - fxGap - padLeft - padGap * 2f) / 3f,
            (contentBottom - padTop - padGap * 2f) / 3f
        )

        for (row in 0 until 3) {
            for (col in 0 until 3) {
                val index = row * 3 + col
                val left = padLeft + col * (padSize + padGap)
                val top = padTop + row * (padSize + padGap)
                drumPadRects[index].set(left, top, left + padSize, top + padSize)
            }
        }

        val fxSlotGap = 10f
        val fxSlotHeight = (contentBottom - contentTop - fxSlotGap * 3f) / 4f
        for (index in drumFxRects.indices) {
            val top = contentTop + index * (fxSlotHeight + fxSlotGap)
            drumFxRects[index].set(fxLeft, top, contentRight, top + fxSlotHeight)
        }
    }

    private fun layoutHybridScreen() {
        val contentTop = keyboardRect.top + 68f
        val contentBottom = height.toFloat() - 18f
        val contentLeft = 18f
        val contentRight = width.toFloat() - 18f
        val padGap = 14f
        val contentWidth = contentRight - contentLeft
        val leftPaneWidth = contentWidth * 0.5f - padGap * 0.5f
        val rightPaneLeft = contentLeft + leftPaneWidth + padGap
        val padWidth = (leftPaneWidth - padGap) / 2f
        val padHeight = (contentBottom - contentTop - padGap * 2f) / 3f

        for (row in 0 until 3) {
            for (col in 0 until 2) {
                val index = row * 2 + col
                val left = contentLeft + col * (padWidth + padGap)
                val top = contentTop + row * (padHeight + padGap)
                hybridPadRects[index].set(left, top, left + padWidth, top + padHeight)
            }
        }

        val rightPaneWidth = contentRight - rightPaneLeft
        val modSize = min(rightPaneWidth, contentBottom - contentTop)
        val modLeft = rightPaneLeft + (rightPaneWidth - modSize) * 0.5f
        val modTop = contentTop + ((contentBottom - contentTop) - modSize) * 0.5f
        hybridModRect.set(modLeft, modTop, modLeft + modSize, modTop + modSize)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), bgPaint)

        drawNavBar(canvas)
        when (currentScreen) {
            ControllerScreen.PIANO -> drawKeyboard(canvas)
            ControllerScreen.DRUM_PADS -> drawDrumPadScreen(canvas)
            ControllerScreen.HYBRID_MOD -> drawHybridScreen(canvas)
        }
        if (isSettingsOpen) {
            drawSettingsOverlay(canvas)
        }
    }

    private fun drawNavBar(canvas: Canvas) {
        val navHeight = navRect.height()
        val titleY = navRect.top + navHeight * 0.42f
        val valueY = navRect.top + navHeight * 0.74f
        val ribbonLabelY = navRect.top + navHeight * 0.82f
        panelRect.set(10f, 10f, width.toFloat() - 10f, navRect.bottom - 6f)

        navPanelGlowPaint.color = Color.parseColor("#082F49")
        navPanelGlowPaint.alpha = 45
        tempRect.set(panelRect.left, panelRect.top, panelRect.right, panelRect.bottom + 6f)
        canvas.drawRoundRect(tempRect, 24f, 24f, navPanelGlowPaint)
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

        // 2. Octave shift (-) and (+) buttons and display
        // Octave [-] button
        tempRect.set(btnOctaveDown.left, btnOctaveDown.top + 4f, btnOctaveDown.right, btnOctaveDown.bottom + 4f)
        canvas.drawRoundRect(tempRect, 12f, 12f, shadowPaint)
        canvas.drawRoundRect(btnOctaveDown, 12f, 12f, buttonPaint)
        canvas.drawRoundRect(btnOctaveDown, 12f, 12f, borderPaint)
        canvas.drawText("-", btnOctaveDown.centerX(), btnOctaveDown.centerY() + 15f, textPaint.apply { textSize = 50f })

        // Current Octave visual display in the center of buttons
        val octaveCenterX = (btnOctaveDown.right + btnOctaveUp.left) / 2f
        canvas.drawText("C$currentOctave", octaveCenterX, valueY, valuePaint.apply { textSize = 30f })

        // Octave [+] button
        tempRect.set(btnOctaveUp.left, btnOctaveUp.top + 4f, btnOctaveUp.right, btnOctaveUp.bottom + 4f)
        canvas.drawRoundRect(tempRect, 12f, 12f, shadowPaint)
        canvas.drawRoundRect(btnOctaveUp, 12f, 12f, buttonPaint)
        canvas.drawRoundRect(btnOctaveUp, 12f, 12f, borderPaint)
        canvas.drawText("+", btnOctaveUp.centerX(), btnOctaveUp.centerY() + 15f, textPaint.apply { textSize = 50f })

        // 3. Pitch Bend Ribbon (0 - 16383)
        tempRect.set(rectPitchBend.left, rectPitchBend.top + 4f, rectPitchBend.right, rectPitchBend.bottom + 4f)
        canvas.drawRoundRect(tempRect, 10f, 10f, shadowPaint)
        canvas.drawRoundRect(rectPitchBend, 10f, 10f, ribbonBgPaint)
        canvas.drawRoundRect(rectPitchBend, 10f, 10f, borderPaint)
        tempRect.set(rectPitchBend.left + 6f, rectPitchBend.centerY() - 3f, rectPitchBend.right - 6f, rectPitchBend.centerY() + 3f)
        canvas.drawRoundRect(tempRect, 4f, 4f, ribbonTrackPaint)
        
        // Draw relative horizontal slider line or bar for Pitch Bend
        val pbPercentage = (pitchBendValue - 0).toFloat() / 16383f
        val pbX = rectPitchBend.left + (rectPitchBend.width() * pbPercentage)
        val fillWidth = 8f
        tempRect.set(pbX - fillWidth, rectPitchBend.top + 4f, pbX + fillWidth, rectPitchBend.bottom - 4f)
        canvas.drawRoundRect(tempRect, 4f, 4f, ribbonFillPaint)
        canvas.drawText("PITCH BEND", rectPitchBend.centerX(), ribbonLabelY, labelPaint.apply {
            textSize = 17f
            textAlign = Paint.Align.CENTER
        })

        // 4. Modulation Ribbon
        tempRect.set(rectModulation.left, rectModulation.top + 4f, rectModulation.right, rectModulation.bottom + 4f)
        canvas.drawRoundRect(tempRect, 10f, 10f, shadowPaint)
        canvas.drawRoundRect(rectModulation, 10f, 10f, ribbonBgPaint)
        canvas.drawRoundRect(rectModulation, 10f, 10f, borderPaint)
        
        // Draw Modulation indicator bar
        val modPercentage = modulationValue.toFloat() / 127f
        val modX = rectModulation.left + (rectModulation.width() * modPercentage)
        tempRect.set(rectModulation.left + 4f, rectModulation.top + 4f, modX, rectModulation.bottom - 4f)
        canvas.drawRoundRect(tempRect, 6f, 6f, ribbonFillPaint.apply { alpha = 130 })
        
        tempRect.set(modX - 5f, rectModulation.top + 4f, modX + 5f, rectModulation.bottom - 4f)
        canvas.drawRoundRect(tempRect, 3f, 3f, ribbonFillPaint.apply { alpha = 255 })
        canvas.drawText("MODULATION", rectModulation.centerX(), ribbonLabelY, labelPaint.apply {
            textSize = 17f
            textAlign = Paint.Align.CENTER
        })

        // 5. Sustain pedal Toggle
        val sustColor = if (isSustainActive) buttonActivePaint else buttonPaint
        tempRect.set(btnSustain.left, btnSustain.top + 4f, btnSustain.right, btnSustain.bottom + 4f)
        canvas.drawRoundRect(tempRect, 12f, 12f, shadowPaint)
        canvas.drawRoundRect(btnSustain, 12f, 12f, sustColor)
        canvas.drawRoundRect(btnSustain, 12f, 12f, if (isSustainActive) accentBorderPaint else borderPaint)
        canvas.drawText("SUSTAIN", btnSustain.centerX(), titleY, labelPaint.apply {
            textSize = 18f
            textAlign = Paint.Align.CENTER
        })
        canvas.drawText(if (isSustainActive) "HOLD" else "OFF", btnSustain.centerX(), valueY, valuePaint.apply { textSize = 23f })

        // 6. Velocity Mode Button
        tempRect.set(btnVelocity.left, btnVelocity.top + 4f, btnVelocity.right, btnVelocity.bottom + 4f)
        canvas.drawRoundRect(tempRect, 12f, 12f, shadowPaint)
        canvas.drawRoundRect(btnVelocity, 12f, 12f, buttonPaint)
        canvas.drawRoundRect(btnVelocity, 12f, 12f, if (isDynamicVelocity) accentBorderPaint else borderPaint)
        canvas.drawText("VELOCITY", btnVelocity.centerX(), titleY, labelPaint.apply {
            textSize = 18f
            textAlign = Paint.Align.CENTER
        })
        canvas.drawText(if (isDynamicVelocity) "DYNAMIC" else "FIXED 100", btnVelocity.centerX(), valueY, valuePaint.apply { textSize = 20f })

        // 7. Settings icon area
        tempRect.set(btnSettings.left, btnSettings.top + 4f, btnSettings.right, btnSettings.bottom + 4f)
        canvas.drawRoundRect(tempRect, 12f, 12f, shadowPaint)
        canvas.drawRoundRect(btnSettings, 12f, 12f, buttonPaint)
        canvas.drawRoundRect(btnSettings, 12f, 12f, borderPaint)
        drawSettingsIcon(canvas, btnSettings.centerX(), btnSettings.centerY())
    }

    private fun drawSettingsOverlay(canvas: Canvas) {
        tempRect.set(0f, keyboardRect.top, width.toFloat(), height.toFloat())
        val overlayShadePaint = bgPaint.apply { alpha = 210 }
        canvas.drawRect(tempRect, overlayShadePaint)
        bgPaint.alpha = 255

        tempRect.set(settingsOverlayRect.left, settingsOverlayRect.top + 8f, settingsOverlayRect.right, settingsOverlayRect.bottom + 8f)
        canvas.drawRoundRect(tempRect, 26f, 26f, shadowPaint)
        canvas.drawRoundRect(settingsOverlayRect, 24f, 24f, navPanelPaint)
        canvas.drawRoundRect(settingsOverlayRect, 24f, 24f, accentBorderPaint)
        canvas.drawText("LAYOUT SELECT", settingsOverlayRect.centerX(), settingsOverlayRect.top + 40f, labelPaint.apply {
            textSize = 22f
            textAlign = Paint.Align.CENTER
        })
        canvas.drawText("Choose the performance surface", settingsOverlayRect.centerX(), settingsOverlayRect.top + 68f, labelPaint.apply {
            textSize = 15f
            textAlign = Paint.Align.CENTER
            alpha = 190
        })
        labelPaint.alpha = 255

        for (index in settingsOptionRects.indices) {
            val rect = settingsOptionRects[index]
            val isActive = currentScreen.ordinal == index
            canvas.drawRoundRect(rect, 18f, 18f, if (isActive) buttonActivePaint else buttonPaint)
            canvas.drawRoundRect(rect, 18f, 18f, if (isActive) accentBorderPaint else borderPaint)

            canvas.drawText(settingsTitles[index], rect.centerX(), rect.top + rect.height() * 0.42f, valuePaint.apply {
                textSize = 17f
                textAlign = Paint.Align.CENTER
            })
            canvas.drawText(settingsSubtitles[index], rect.centerX(), rect.top + rect.height() * 0.68f, labelPaint.apply {
                textSize = 13f
                textAlign = Paint.Align.CENTER
                alpha = 215
            })
            labelPaint.alpha = 255
        }
    }

    private fun drawDrumPadScreen(canvas: Canvas) {
        drawScreenHeader(canvas, "DRUM MATRIX", "9 responsive pads, row levels and live FX")

        for (index in drumLevelRects.indices) {
            val rect = drumLevelRects[index]
            val level = drumRowLevels[index].toFloat() / 127f
            canvas.drawRoundRect(rect, 12f, 12f, ribbonBgPaint)
            canvas.drawRoundRect(rect, 12f, 12f, borderPaint)

            val fillTop = rect.bottom - rect.height() * level
            tempRect.set(rect.left + 5f, fillTop, rect.right - 5f, rect.bottom - 5f)
            canvas.drawRoundRect(tempRect, 8f, 8f, ribbonFillPaint.apply { alpha = 170 })
            canvas.drawText(drumRowLabels[index], rect.centerX(), rect.top + 22f, valuePaint.apply {
                textSize = 18f
                textAlign = Paint.Align.CENTER
            })
            canvas.drawText(drumRowLevels[index].toString(), rect.centerX(), rect.bottom - 16f, labelPaint.apply {
                textSize = 14f
                textAlign = Paint.Align.CENTER
            })
        }

        for (index in drumPadRects.indices) {
            val rect = drumPadRects[index]
            val assignment = drumPadAssignments[index]
            val isActive = currentlyPressedNotes.contains(assignment.note)
            canvas.drawRoundRect(rect, 14f, 14f, if (isActive) whiteKeyActivePaint else buttonPaint)
            canvas.drawRoundRect(rect, 14f, 14f, if (isActive) accentBorderPaint else borderPaint)
            canvas.drawText(assignment.label, rect.centerX(), rect.centerY() + 4f, valuePaint.apply {
                textSize = 17f
                textAlign = Paint.Align.CENTER
            })
            canvas.drawText((index + 1).toString(), rect.centerX(), rect.bottom - 14f, labelPaint.apply {
                textSize = 13f
                textAlign = Paint.Align.CENTER
                alpha = 200
            })
            labelPaint.alpha = 255
        }

        for (index in drumFxRects.indices) {
            val rect = drumFxRects[index]
            val assignment = drumFxAssignments[index]
            val value = drumFxValues[index].toFloat() / 127f
            canvas.drawRoundRect(rect, 12f, 12f, buttonPaint)
            canvas.drawRoundRect(rect, 12f, 12f, borderPaint)

            val trackLeft = rect.centerX() - 8f
            val trackRight = rect.centerX() + 8f
            tempRect.set(trackLeft, rect.top + 26f, trackRight, rect.bottom - 14f)
            canvas.drawRoundRect(tempRect, 8f, 8f, ribbonTrackPaint)

            val fillTop = tempRect.bottom - tempRect.height() * value
            tempRect.set(trackLeft, fillTop, trackRight, rect.bottom - 14f)
            canvas.drawRoundRect(tempRect, 8f, 8f, ribbonFillPaint.apply { alpha = 200 })

            canvas.drawText(assignment.label, rect.centerX(), rect.top + 16f, labelPaint.apply {
                textSize = 10f
                textAlign = Paint.Align.CENTER
            })
            canvas.drawText(drumFxValues[index].toString(), rect.centerX(), rect.bottom - 3f, labelPaint.apply {
                textSize = 11f
                textAlign = Paint.Align.CENTER
                alpha = 210
            })
            labelPaint.alpha = 255
        }
    }

    private fun drawHybridScreen(canvas: Canvas) {
        drawScreenHeader(canvas, "PADS + XY MOD", "Trigger pads and shape modulation")

        for (index in hybridPadRects.indices) {
            val rect = hybridPadRects[index]
            val assignment = hybridPadAssignments[index]
            val isActive = currentlyPressedNotes.contains(assignment.note)
            canvas.drawRoundRect(rect, 14f, 14f, if (isActive) whiteKeyActivePaint else buttonPaint)
            canvas.drawRoundRect(rect, 14f, 14f, if (isActive) accentBorderPaint else borderPaint)
            canvas.drawText(assignment.label, rect.centerX(), rect.centerY() + 6f, valuePaint.apply {
                textSize = 19f
                textAlign = Paint.Align.CENTER
            })
        }

        canvas.drawRoundRect(hybridModRect, 16f, 16f, ribbonBgPaint)
        canvas.drawRoundRect(hybridModRect, 16f, 16f, borderPaint)
        tempRect.set(hybridModRect.left + 12f, hybridModRect.centerY() - 1.5f, hybridModRect.right - 12f, hybridModRect.centerY() + 1.5f)
        canvas.drawRoundRect(tempRect, 2f, 2f, ribbonTrackPaint)
        tempRect.set(hybridModRect.centerX() - 1.5f, hybridModRect.top + 12f, hybridModRect.centerX() + 1.5f, hybridModRect.bottom - 12f)
        canvas.drawRoundRect(tempRect, 2f, 2f, ribbonTrackPaint)

        val modX = hybridModRect.left + (hybridModRect.width() * (hybridModXValue / 127f))
        val modY = hybridModRect.bottom - (hybridModRect.height() * (hybridModYValue / 127f))
        canvas.drawCircle(modX, modY, 20f, ribbonFillPaint.apply { alpha = 210 })
        canvas.drawText(hybridXYAssignment.label, hybridModRect.centerX(), hybridModRect.top + 26f, labelPaint.apply {
            textSize = 20f
            textAlign = Paint.Align.CENTER
        })
        canvas.drawText("EXTEND OUTSIDE TO KEEP MODULATING", hybridModRect.centerX(), hybridModRect.top + 46f, labelPaint.apply {
            textSize = 10f
            textAlign = Paint.Align.CENTER
            alpha = 180
        })
        canvas.drawText("X ${hybridModXValue}", hybridModRect.left + 44f, hybridModRect.bottom - 14f, labelPaint.apply {
            textSize = 14f
            textAlign = Paint.Align.CENTER
        })
        canvas.drawText("Y ${hybridModYValue}", hybridModRect.right - 44f, hybridModRect.bottom - 14f, labelPaint.apply {
            textSize = 14f
            textAlign = Paint.Align.CENTER
        })
        labelPaint.alpha = 255
    }

    private fun drawScreenHeader(canvas: Canvas, title: String, subtitle: String) {
        val headerLeft = keyboardRect.left + 16f
        val headerTop = keyboardRect.top + 10f
        val headerWidth = min(width * 0.44f, 340f)
        val headerHeight = 46f
        tempRect.set(headerLeft, headerTop, headerLeft + headerWidth, headerTop + headerHeight)
        canvas.drawRoundRect(tempRect, 16f, 16f, buttonPaint)
        canvas.drawRoundRect(tempRect, 16f, 16f, borderPaint)
        canvas.drawText(title, tempRect.left + 18f, tempRect.top + 19f, valuePaint.apply {
            textSize = 16f
            textAlign = Paint.Align.LEFT
        })
        canvas.drawText(subtitle, tempRect.left + 18f, tempRect.top + 36f, labelPaint.apply {
            textSize = 11f
            textAlign = Paint.Align.LEFT
            alpha = 210
        })
        labelPaint.alpha = 255
    }

    private fun drawKeyboard(canvas: Canvas) {
        val yOffset = keyboardRect.top
        val bottom = height.toFloat()

        // Draw white keys first
        for (i in 0 until totalWhiteKeys) {
            val keyLeft = i * whiteKeyWidth
            val keyRight = keyLeft + whiteKeyWidth
            
            val scaleNote = whiteKeySemitones[i]
            val midiNote = getMidiNoteNumber(scaleNote)

            val paint = if (currentlyPressedNotes.contains(midiNote)) whiteKeyActivePaint else whiteKeyPaint
            canvas.drawRect(keyLeft, yOffset, keyRight, bottom, paint)
            canvas.drawRect(keyLeft, yOffset, keyRight, bottom, whiteKeyBorderPaint)
        }

        // Draw black keys on top
        for (i in blackKeyWhiteParentIndices.indices) {
            val parentIdx = blackKeyWhiteParentIndices[i]
            val semitone = blackKeySemitones[i]
            val midiNote = getMidiNoteNumber(semitone)

            val parentLeft = parentIdx * whiteKeyWidth
            val keyLeft = parentLeft + whiteKeyWidth - (blackKeyWidth / 2f)
            val keyRight = keyLeft + blackKeyWidth

            val paint = if (currentlyPressedNotes.contains(midiNote)) blackKeyActivePaint else blackKeyPaint
            canvas.drawRect(keyLeft, yOffset, keyRight, yOffset + blackKeyHeight, paint)
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
                // Consume historical points first so fast drags and glissandos are not flattened
                // into a single latest coordinate sample on busy devices.
                val historySize = event.historySize
                for (historyIndex in 0 until historySize) {
                    for (i in 0 until pointerCount) {
                        val pointerId = event.getPointerId(i)
                        val x = event.getHistoricalX(i, historyIndex)
                        val y = event.getHistoricalY(i, historyIndex)
                        handleTouchMove(pointerId, x, y)
                    }
                }

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
        
        postInvalidateOnAnimation()
        return true
    }

    private fun handleTouchStart(pointerId: Int, x: Float, y: Float) {
        val activeTouch = ActiveTouch()
        if (btnSettings.contains(x, y)) {
            isSettingsOpen = !isSettingsOpen
            if (isSettingsOpen) {
                releaseAllActiveNotes()
                activeTouches.clear()
            }
            return
        }

        if (isSettingsOpen) {
            val selectedScreen = getSettingsScreenAt(x, y)
            if (selectedScreen != null) {
                switchScreen(selectedScreen)
            } else {
                isSettingsOpen = false
            }
            return
        }

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
            when (currentScreen) {
                ControllerScreen.PIANO -> {
                    activeTouch.touchType = TouchType.PIANO_KEY
                    val noteCode = getNoteAtCoordinate(x, y)
                    if (noteCode != -1) {
                        activeTouch.noteTriggered = noteCode
                        val velocity = calculateVelocity(y)
                        triggerNoteOn(noteCode, velocity)
                    }
                }
                ControllerScreen.DRUM_PADS -> {
                    if (!tryStartDrumScreenTouch(activeTouch, x, y)) {
                        activeTouches.remove(pointerId)
                    }
                    return
                }
                ControllerScreen.HYBRID_MOD -> {
                    if (!tryStartHybridScreenTouch(activeTouch, x, y)) {
                        activeTouches.remove(pointerId)
                    }
                    return
                }
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
            TouchType.DRUM_PAD -> {
                updatePadTouch(activeTouch, x, y, drumPadRects, drumPadAssignments) { index -> drumVelocityForPad(index) }
            }
            TouchType.DRUM_LEVEL -> {
                updateDrumLevel(activeTouch.controlIndex, y)
            }
            TouchType.DRUM_FX -> {
                updateDrumFx(activeTouch.controlIndex, y)
            }
            TouchType.HYBRID_PAD -> {
                updatePadTouch(activeTouch, x, y, hybridPadRects, hybridPadAssignments) { 110 }
            }
            TouchType.HYBRID_XY -> {
                updateHybridMod(x, y)
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
                dispatchPitchBendIfChanged()
            }
            TouchType.MODULATION -> {
                // Hold value - do nothing to the modulationValue! Its state persists.
            }
            TouchType.DRUM_PAD, TouchType.HYBRID_PAD -> {
                if (activeTouch.noteTriggered != -1) {
                    triggerNoteOff(activeTouch.noteTriggered)
                }
            }
            TouchType.HYBRID_XY -> {
                hybridModXValue = 64
                hybridModYValue = 64
                dispatchHybridModIfChanged()
            }
            else -> {}
        }
    }

    private fun tryStartDrumScreenTouch(activeTouch: ActiveTouch, x: Float, y: Float): Boolean {
        for (index in drumLevelRects.indices) {
            if (drumLevelRects[index].contains(x, y)) {
                activeTouch.touchType = TouchType.DRUM_LEVEL
                activeTouch.controlIndex = index
                updateDrumLevel(index, y)
                return true
            }
        }

        for (index in drumFxRects.indices) {
            if (drumFxRects[index].contains(x, y)) {
                activeTouch.touchType = TouchType.DRUM_FX
                activeTouch.controlIndex = index
                updateDrumFx(index, y)
                return true
            }
        }

        val padIndex = findPadIndexAt(x, y, drumPadRects)
        if (padIndex != -1) {
            activeTouch.touchType = TouchType.DRUM_PAD
            val assignment = drumPadAssignments[padIndex]
            activeTouch.noteTriggered = assignment.note
            dispatchAssignedPadNoteOn(assignment, drumVelocityForPad(padIndex))
            return true
        }

        return false
    }

    private fun tryStartHybridScreenTouch(activeTouch: ActiveTouch, x: Float, y: Float): Boolean {
        val padIndex = findPadIndexAt(x, y, hybridPadRects)
        if (padIndex != -1) {
            activeTouch.touchType = TouchType.HYBRID_PAD
            val assignment = hybridPadAssignments[padIndex]
            activeTouch.noteTriggered = assignment.note
            dispatchAssignedPadNoteOn(assignment, 110)
            return true
        }

        if (isPointWithinHybridModCatchArea(x, y)) {
            activeTouch.touchType = TouchType.HYBRID_XY
            updateHybridMod(x, y)
            return true
        }

        return false
    }

    private fun updatePadTouch(
        activeTouch: ActiveTouch,
        x: Float,
        y: Float,
        padRects: Array<RectF>,
        assignments: Array<PadAssignment>,
        velocityProvider: (Int) -> Int
    ) {
        val padIndex = findPadIndexAt(x, y, padRects)
        if (padIndex == -1) {
            if (activeTouch.noteTriggered != -1) {
                triggerNoteOff(activeTouch.noteTriggered)
                activeTouch.noteTriggered = -1
            }
            return
        }

        val assignment = assignments[padIndex]
        val nextNote = assignment.note
        if (nextNote == activeTouch.noteTriggered) return

        if (activeTouch.noteTriggered != -1) {
            triggerNoteOff(activeTouch.noteTriggered)
        }
        activeTouch.noteTriggered = nextNote
        dispatchAssignedPadNoteOn(assignment, velocityProvider(padIndex))
    }

    private fun updateDrumLevel(index: Int, y: Float) {
        if (index !in drumLevelRects.indices) return
        val rect = drumLevelRects[index]
        val ratio = ((rect.bottom - y) / rect.height()).coerceIn(0f, 1f)
        drumRowLevels[index] = (20 + ratio * 107f).toInt().coerceIn(1, 127)
    }

    private fun updateDrumFx(index: Int, y: Float) {
        if (index !in drumFxRects.indices) return
        val rect = drumFxRects[index]
        val ratio = ((rect.bottom - y) / rect.height()).coerceIn(0f, 1f)
        val value = (ratio * 127f).toInt().coerceIn(0, 127)
        if (drumFxValues[index] == value) return
        drumFxValues[index] = value
        dispatchAssignedFaderValue(drumFxAssignments[index], value)
    }

    private fun updateHybridMod(x: Float, y: Float) {
        val normalizedX = ((x - hybridModRect.left) / hybridModRect.width()).coerceIn(0f, 1f)
        val normalizedY = (1f - ((y - hybridModRect.top) / hybridModRect.height())).coerceIn(0f, 1f)
        hybridModXValue = (normalizedX * 127f).toInt()
        hybridModYValue = (normalizedY * 127f).toInt()
        dispatchHybridModIfChanged()
    }

    private fun isPointWithinHybridModCatchArea(x: Float, y: Float): Boolean {
        val captureMargin = 34f
        return x >= hybridModRect.left - captureMargin &&
            x <= hybridModRect.right + captureMargin &&
            y >= hybridModRect.top - captureMargin &&
            y <= hybridModRect.bottom + captureMargin
    }

    private fun dispatchHybridModIfChanged() {
        if (hybridModXValue != lastDispatchedHybridModX) {
            lastDispatchedHybridModX = hybridModXValue
            dispatchAssignedXYAxis(hybridXYAssignment.xCc, hybridXYAssignment.channel, hybridModXValue)
        }
        if (hybridModYValue != lastDispatchedHybridModY) {
            lastDispatchedHybridModY = hybridModYValue
            dispatchAssignedXYAxis(hybridXYAssignment.yCc, hybridXYAssignment.channel, hybridModYValue)
        }
    }

    private fun dispatchAssignedPadNoteOn(assignment: PadAssignment, velocity: Int) {
        triggerNoteOn(assignment.note, velocity)
    }

    private fun dispatchAssignedFaderValue(assignment: FaderAssignment, value: Int) {
        // Channel is carried in the assignment model for future multi-channel routing.
        eventListener?.onControlChange(assignment.cc, value)
    }

    private fun dispatchAssignedXYAxis(cc: Int, @Suppress("UNUSED_PARAMETER") channel: Int, value: Int) {
        // Channel is reserved for the next routing layer; current transport stays on channel 0.
        eventListener?.onControlChange(cc, value)
    }

    private fun drumVelocityForPad(padIndex: Int): Int {
        val rowIndex = (padIndex / 3).coerceIn(0, drumRowLevels.lastIndex)
        return drumRowLevels[rowIndex]
    }

    private fun findPadIndexAt(x: Float, y: Float, padRects: Array<RectF>): Int {
        for (index in padRects.indices) {
            if (padRects[index].contains(x, y)) {
                return index
            }
        }
        return -1
    }

    private fun getSettingsScreenAt(x: Float, y: Float): ControllerScreen? {
        for (index in settingsOptionRects.indices) {
            if (settingsOptionRects[index].contains(x, y)) {
                return ControllerScreen.values()[index]
            }
        }
        return null
    }

    private fun switchScreen(screen: ControllerScreen) {
        if (currentScreen == screen) {
            isSettingsOpen = false
            return
        }
        releaseAllActiveNotes()
        activeTouches.clear()
        currentScreen = screen
        isSettingsOpen = false
    }

    private fun updatePitchBend(x: Float) {
        val width = rectPitchBend.width()
        val relativeX = (x - rectPitchBend.left).coerceIn(0f, width)
        val ratio = relativeX / width // 0.0 to 1.0
        val centered = ((ratio - 0.5f) * 2f).coerceIn(-1f, 1f)
        val shaped = shapeCenteredControl(centered, exponent = 0.68f)
        val normalized = ((shaped + 1f) * 0.5f).coerceIn(0f, 1f)
        pitchBendValue = (normalized * 16383f).toInt()
        dispatchPitchBendIfChanged()
    }

    private fun updateModulation(x: Float) {
        val width = rectModulation.width()
        val relativeX = (x - rectModulation.left).coerceIn(0f, width)
        val ratio = relativeX / width // 0.0 to 1.0
        val shaped = ratio.toDouble().pow(0.7).toFloat().coerceIn(0f, 1f)
        modulationValue = (shaped * 127f).toInt()
        dispatchModulationIfChanged()
    }

    private fun dispatchPitchBendIfChanged() {
        if (pitchBendValue == lastDispatchedPitchBendValue) return
        lastDispatchedPitchBendValue = pitchBendValue
        eventListener?.onPitchBend(pitchBendValue)
    }

    private fun dispatchModulationIfChanged() {
        if (modulationValue == lastDispatchedModulationValue) return
        lastDispatchedModulationValue = modulationValue
        eventListener?.onControlChange(1, modulationValue)
    }

    private fun shapeCenteredControl(value: Float, exponent: Float): Float {
        val magnitude = abs(value).toDouble().pow(exponent.toDouble()).toFloat()
        return if (value < 0f) -magnitude else magnitude
    }

    private fun drawSettingsIcon(canvas: Canvas, centerX: Float, centerY: Float) {
        val outerRadius = 15f
        val innerRadius = 6f
        val toothLength = 7f

        for (index in 0 until 8) {
            val angle = (PI / 4.0) * index
            val startX = centerX + cos(angle).toFloat() * outerRadius
            val startY = centerY + sin(angle).toFloat() * outerRadius
            val endX = centerX + cos(angle).toFloat() * (outerRadius + toothLength)
            val endY = centerY + sin(angle).toFloat() * (outerRadius + toothLength)
            canvas.drawLine(startX, startY, endX, endY, settingsIconPaint)
        }

        canvas.drawCircle(centerX, centerY, outerRadius, settingsIconPaint)
        canvas.drawCircle(centerX, centerY, innerRadius, settingsIconPaint)
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
            if (
                touch.touchType == TouchType.PIANO_KEY ||
                touch.touchType == TouchType.DRUM_PAD ||
                touch.touchType == TouchType.HYBRID_PAD
            ) {
                touch.noteTriggered = -1
            }
        }
    }
}
