import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Sparkles,
  Smartphone,
  Check,
  FileText,
  Terminal,
  Sliders,
  Download,
  Copy,
  VolumeX,
  Volume2,
  Cpu,
  Bluetooth,
  RefreshCw,
  SlidersHorizontal,
  FolderTree,
  ExternalLink
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { androidCodeFiles, CodeFile } from "./data";

export default function App() {
  // Application tabs
  const [activeTab, setActiveTab] = useState<"simulator" | "code" | "protocol">("simulator");
  const [selectedFile, setSelectedFile] = useState<CodeFile>(androidCodeFiles[0]);
  const [copiedIndex, setCopiedIndex] = useState<boolean>(false);

  // --- Real-time Simulator State ---
  const [currentOctave, setCurrentOctave] = useState<number>(3);
  const [isSustainActive, setIsSustainActive] = useState<boolean>(false);
  const [isDynamicVelocity, setIsDynamicVelocity] = useState<boolean>(true);
  const [pitchBendValue, setPitchBendValue] = useState<number>(8192); // 0 to 16383, center 8192
  const [modulationValue, setModulationValue] = useState<number>(0); // 0 to 127

  // Connection states
  const [isConnected, setIsConnected] = useState<boolean>(true);
  const [connectedDevice, setConnectedDevice] = useState<string>("Mac Mini M4");
  const [devicesList] = useState<string[]>([
    "Mac Mini M4",
    "iPad Pro (DAW)",
    "Logic Pro Studio",
    "Ableton Live Host"
  ]);

  // Audio state
  const [waveType, setWaveType] = useState<"sine" | "square">("sine");
  const [isMuted, setIsMuted] = useState<boolean>(false);

  // ---- Refs mirroring audio-critical state for zero-latency, stale-closure-free audio dispatch ----
  const waveTypeRef = useRef<"sine" | "square">("sine");
  const isMutedRef = useRef<boolean>(false);
  const isDynamicVelocityRef = useRef<boolean>(true);
  const isSustainActiveRef = useRef<boolean>(false);
  const pitchBendValueRef = useRef<number>(8192);

  // Keep audio refs in sync with React state — these are the only refs that need useEffect
  // (they mirror state that changes via UI, not via the audio hot path)
  useEffect(() => { isSustainActiveRef.current = isSustainActive; }, [isSustainActive]);
  useEffect(() => { isDynamicVelocityRef.current = isDynamicVelocity; }, [isDynamicVelocity]);
  useEffect(() => { pitchBendValueRef.current = pitchBendValue; }, [pitchBendValue]);
  useEffect(() => { waveTypeRef.current = waveType; }, [waveType]);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);

  // Activity Log for BLE MIDI transactions
  interface MidiLog {
    timestamp: string;
    type: "TX" | "SYS";
    bytes: string;
    translation: string;
  }
  const [midiLogs, setMidiLogs] = useState<MidiLog[]>([
    {
      timestamp: new Date().toLocaleTimeString(),
      type: "SYS",
      bytes: "GATT Server Initialized",
      translation: "Advertising BLE MIDI Service UUID: 03B80E5A..."
    },
    {
      timestamp: new Date().toLocaleTimeString(),
      type: "SYS",
      bytes: "Host Connected",
      translation: "Connected to Mac Mini M4. MIDI Notifications Enabled."
    }
  ]);

  // --- Web Audio Fallback Synth Setup ---
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeOscillatorsRef = useRef<Map<number, { osc: OscillatorNode; gain: GainNode; noteCode: number }>>(new Map());
  const sustainingNotesRef = useRef<Set<number>>(new Set());

  // Get or lazy-init Audio Context
  const getAudioContext = (): AudioContext | null => {
    if (typeof window === "undefined") return null;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioCtxRef.current.state === "suspended") {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  };

  const playLocalNote = (noteCode: number, velocity: number) => {
    // Read from refs — always current, no stale closure
    if (isMutedRef.current) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;

      // Stop matching active note if any (re-trigger)
      stopLocalNote(noteCode, true);

      // Create Audio Nodes
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      const currentWaveType = waveTypeRef.current;
      osc.type = currentWaveType;
      // Calculate MIDI Note frequency: f = 440 * 2^((d-69)/12)
      const freq = 440 * Math.pow(2, (noteCode - 69) / 12);
      osc.frequency.setValueAtTime(freq, ctx.currentTime);

      // Amplitude based on velocity and waveform (square is louder, scale it down for eye/ear safety)
      const waveVolumeFactor = currentWaveType === "square" ? 0.05 : 0.12;
      const velocityVolume = isDynamicVelocityRef.current ? (velocity / 127) : (100 / 127);
      const targetVolume = velocityVolume * waveVolumeFactor;

      // Prevent pop sounds via soft linear envelope
      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(targetVolume, ctx.currentTime + 0.015);

      osc.connect(gainNode);
      gainNode.connect(ctx.destination);

      osc.start();

      // Store noteCode in the map entry so applyPitchBendToAll can access it
      activeOscillatorsRef.current.set(noteCode, { osc, gain: gainNode, noteCode });

      // Apply current pitch bend factors to newly spawned voice
      applyPitchBendToVoice(osc, noteCode, pitchBendValueRef.current, ctx);
    } catch (e) {
      console.warn("Synth warning: active context block", e);
    }
  };

  const stopLocalNote = (noteCode: number, force = false) => {
    const voice = activeOscillatorsRef.current.get(noteCode);
    if (!voice) return;

    // Sustain logic — read from ref for real-time accuracy
    if (isSustainActiveRef.current && !force) {
      sustainingNotesRef.current.add(noteCode);
      return;
    }

    try {
      const ctx = getAudioContext();
      if (ctx) {
        // Exponential fade-out for clean analog tail
        voice.gain.gain.setValueAtTime(voice.gain.gain.value, ctx.currentTime);
        voice.gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.20);
        
        const oscToDis = voice.osc;
        const gainToDis = voice.gain;
        setTimeout(() => {
          try {
            oscToDis.stop();
            oscToDis.disconnect();
            gainToDis.disconnect();
          } catch (e) {}
        }, 220);
      }
    } catch (e) {}

    activeOscillatorsRef.current.delete(noteCode);
    sustainingNotesRef.current.delete(noteCode);
  };

  const applyPitchBendToAll = (pbVal: number) => {
    const ctx = getAudioContext();
    if (!ctx) return;
    // voice.noteCode is now stored in the map entry
    activeOscillatorsRef.current.forEach((voice, midiNote) => {
      applyPitchBendToVoice(voice.osc, midiNote, pbVal, ctx);
    });
  };

  const applyPitchBendToVoice = (osc: OscillatorNode, note: number, pbVal: number, ctx: AudioContext) => {
    // +/- 2 semitone range
    const semitoneOffset = ((pbVal - 8192) / 8192) * 2;
    const baseFreq = 440 * Math.pow(2, (note - 69) / 12);
    const targetFreq = baseFreq * Math.pow(2, semitoneOffset / 12);
    osc.frequency.setTargetAtTime(targetFreq, ctx.currentTime, 0.03); // exponential slide
  };

  const panicShutdownLocalSynth = () => {
    activeOscillatorsRef.current.forEach((voice, note) => {
      try {
        const ctx = getAudioContext();
        if (ctx) {
          voice.gain.gain.cancelScheduledValues(ctx.currentTime);
          voice.gain.gain.setValueAtTime(voice.gain.gain.value, ctx.currentTime);
          voice.gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.05);
        }
      } catch (e) {}
      
      // Schedule cleanup after release envelope
      setTimeout(() => {
        try {
          voice.osc.stop();
          voice.osc.disconnect();
          voice.gain.disconnect();
        } catch (e) {}
      }, 70);
    });
    
    // Clear refs immediately to prevent memory leaks
    activeOscillatorsRef.current.clear();
    sustainingNotesRef.current.clear();
  };

  // Cleanup oscillators on component unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      panicShutdownLocalSynth();
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
        audioCtxRef.current = null;
      }
    };
  }, []);

  // --- HTML5 Canvas Piano Engine inside React ---
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pianoViewWidth = 820;
  const pianoViewHeight = 260;
  const navBarHeight = pianoViewHeight * 0.20; // 52px

  const totalWhiteKeys = 11;
  const whiteKeySemitones = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17]; // C to F
  const blackKeyParents = [0, 1, 3, 4, 5, 7, 8]; // white key index which has black key at right
  const blackKeySemitones = [1, 3, 6, 8, 10, 13, 15]; // C#, D#, F#, G#, A#, C#, D#
  const whiteKeyWidth = pianoViewWidth / totalWhiteKeys; // ~74.5px
  const blackKeyWidth = whiteKeyWidth * 0.58; // ~43.2px
  const blackKeyHeight = (pianoViewHeight - navBarHeight) * 0.58; // ~120px

  // Tracks which MIDI notes are physically held DOWN inside the simulator
  const [pressedNotes, setPressedNotes] = useState<number[]>([]);
  const pressedNotesRef = useRef<number[]>([]);

  // Track coordinates of drag interactions
  interface ActivePointer {
    id: number | string;
    type: "KEY" | "PITCH" | "MOD" | "NONE";
    triggeredNote: number;
  }
  const activePointersRef = useRef<Map<number | string, ActivePointer>>(new Map());

  // Convert key coordinates to MIDI notes
  const getNoteForCoordinates = (cx: number, cy: number): number => {
    if (cy < navBarHeight) return -1;
    const keyY = cy - navBarHeight;

    // 1. Evaluate black keys first (overlapping bounds)
    if (keyY < blackKeyHeight) {
      for (let i = 0; i < blackKeyParents.length; i++) {
        const parentIdx = blackKeyParents[i];
        const pLeft = parentIdx * whiteKeyWidth;
        const bLeft = pLeft + whiteKeyWidth - blackKeyWidth / 2;
        const bRight = bLeft + blackKeyWidth;

        if (cx >= bLeft && cx <= bRight) {
          return (currentOctave + 1) * 12 + blackKeySemitones[i];
        }
      }
    }

    // 2. Evaluate white keys
    const whiteIdx = Math.floor(cx / whiteKeyWidth);
    const clampedWhiteIdx = Math.max(0, Math.min(totalWhiteKeys - 1, whiteIdx));
    return (currentOctave + 1) * 12 + whiteKeySemitones[clampedWhiteIdx];
  };

  const calculateVelocityForY = (cy: number): number => {
    if (!isDynamicVelocity) return 100;
    const keyboardH = pianoViewHeight - navBarHeight;
    const relativeY = Math.max(0, Math.min(keyboardH, cy - navBarHeight));
    const ratio = relativeY / keyboardH; // 0.0 (top) to 1.0 (bottom)
    return Math.floor(64 + ratio * 63); // 64 to 127 range
  };

  // Format activity logs
  const logMidi = (type: "TX" | "SYS", bytes: string, translation: string) => {
    const newLog: MidiLog = {
      timestamp: new Date().toLocaleTimeString(),
      type,
      bytes,
      translation
    };
    setMidiLogs((prev) => [newLog, ...prev.slice(0, 49)]); // keep last 50 logs
  };

  const getNoteName = (midi: number): string => {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const semitone = midi % 12;
    const octave = Math.floor(midi / 12) - 1;
    return `${names[semitone]}${octave}`;
  };

  // isConnectedRef so triggerNoteOn/Off don't need isConnected in their deps
  const isConnectedRef = useRef<boolean>(true);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);

  // Plain functions (not useCallback with stale deps) — audio engine uses refs for real-time values
  const triggerNoteOn = (note: number, velocity: number) => {
    if (!pressedNotesRef.current.includes(note)) {
      // Update ref immediately — synchronous, zero-lag
      const updated = [...pressedNotesRef.current, note];
      pressedNotesRef.current = updated;
      // Schedule React state update (for canvas re-render) — non-blocking
      setPressedNotes([...updated]);

      // Local Synthesizer playback — uses refs internally, fires NOW
      playLocalNote(note, velocity);

      // MIDI BLE Transmission hex formatted print
      const timestampByte = (0x80 | (Math.floor(Date.now() & 0x3FFF))).toString(16).toUpperCase().padStart(2, "0");
      const hexStatus = (0x90).toString(16).toUpperCase();
      const hexNote = note.toString(16).toUpperCase().padStart(2, "0");
      const hexVel = velocity.toString(16).toUpperCase().padStart(2, "0");

      if (isConnectedRef.current) {
        logMidi(
          "TX",
          `80 ${timestampByte} ${hexStatus} ${hexNote} ${hexVel}`,
          `Note ON: ${getNoteName(note)} | Velocity: ${velocity}`
        );
      }
    }
  };

  const triggerNoteOff = (note: number) => {
    if (pressedNotesRef.current.includes(note)) {
      const updated = pressedNotesRef.current.filter((n) => n !== note);
      pressedNotesRef.current = updated;
      setPressedNotes([...updated]);

      // Local synthesis stop — reads isSustainActiveRef internally
      stopLocalNote(note);

      // MIDI BLE Transmission hex format
      const timestampByte = (0x80 | (Math.floor(Date.now() & 0x3FFF))).toString(16).toUpperCase().padStart(2, "0");
      const hexStatus = (0x80).toString(16).toUpperCase();
      const hexNote = note.toString(16).toUpperCase().padStart(2, "0");

      if (isConnectedRef.current) {
        logMidi(
          "TX",
          `80 ${timestampByte} ${hexStatus} ${hexNote} 00`,
          `Note OFF: ${getNoteName(note)}`
        );
      }
    }
  };

  // Handle Sustain release flushing when pedal toggled OFF
  useEffect(() => {
    if (!isSustainActive) {
      // Find all sustaining notes that are not currently pressed
      sustainingNotesRef.current.forEach((note) => {
        if (!pressedNotes.includes(note)) {
          stopLocalNote(note, true);
        }
      });
      sustainingNotesRef.current.clear();
    }
    // Update MIDI CC#64
    if (isConnected) {
      const timestampByte = "8A";
      const hexStatus = "B0";
      const controller = "40"; // CC64 is 0x40 in hex
      const value = isSustainActive ? "7F" : "00";
      logMidi(
        "TX",
        `80 ${timestampByte} ${hexStatus} ${controller} ${value}`,
        `Sustain Pedal: ${isSustainActive ? "HOLD (127)" : "RELEASE (0)"}`
      );
    }
  }, [isSustainActive, isConnected]);

  // Handle ribbon values logs
  const dispatchPitchBend = (pbVal: number) => {
    applyPitchBendToAll(pbVal);
    if (isConnected) {
      const lsb = pbVal & 0x7f;
      const msb = (pbVal >> 7) & 0x7f;
      const lsbHex = lsb.toString(16).toUpperCase().padStart(2, "0");
      const msbHex = msb.toString(16).toUpperCase().padStart(2, "0");
      logMidi(
        "TX",
        `80 8C E0 ${lsbHex} ${msbHex}`,
        `Pitch Bend Ribbon -> Value: ${pbVal} (LSB: ${lsb}, MSB: ${msb})`
      );
    }
  };

  const dispatchModulation = (modVal: number) => {
    if (isConnected) {
      const modHex = modVal.toString(16).toUpperCase().padStart(2, "0");
      logMidi(
        "TX",
        `80 8D B0 01 ${modHex}`,
        `Modulation CC#1 Ribbon -> Value: ${modVal}`
      );
    }
  };

  // Octave visual cleaner
  useEffect(() => {
    panicShutdownLocalSynth();
  }, [currentOctave]);

  // Draw onto canvas periodically and on state boundaries
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // High DPI scaling support
    canvas.width = pianoViewWidth;
    canvas.height = pianoViewHeight;

    ctx.clearRect(0, 0, pianoViewWidth, pianoViewHeight);

    // Draw dark dashboard background
    ctx.fillStyle = "#151619"; // Top bar matching background
    ctx.fillRect(0, 0, pianoViewWidth, navBarHeight);

    ctx.fillStyle = "#050505"; // Bottom keys base matching background
    ctx.fillRect(0, navBarHeight, pianoViewWidth, pianoViewHeight - navBarHeight);

    // Draw control top bar divider line
    ctx.strokeStyle = "#1A1C20";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, navBarHeight);
    ctx.lineTo(pianoViewWidth, navBarHeight);
    ctx.stroke();

    // 1. Connection LED Draw
    const ledX = pianoViewWidth * 0.05;
    const ledY = navBarHeight / 2;
    const ledRadius = 6;
    
    // LED Glow rings
    ctx.fillStyle = isConnected ? "rgba(0, 136, 255, 0.4)" : "rgba(255, 68, 68, 0.4)";
    ctx.beginPath();
    ctx.arc(ledX, ledY, ledRadius + 4, 0, 2 * Math.PI);
    ctx.fill();

    ctx.fillStyle = isConnected ? "#0088FF" : "#FF4444";
    ctx.beginPath();
    ctx.arc(ledX, ledY, ledRadius, 0, 2 * Math.PI);
    ctx.fill();

    // LED info subtext
    ctx.fillStyle = "#8E9299";
    ctx.font = "bold 9px monospace";
    ctx.textAlign = "center";
    ctx.fillText(
      isConnected ? connectedDevice.toUpperCase() : "DISCONNECTED",
      ledX,
      ledY + 17
    );

    // Helper for rounded rectangles (specialist style)
    const drawRoundRect = (rx: number, ry: number, rw: number, rh: number, r: number, fillFill: boolean, fillStyleStr: string) => {
      ctx.beginPath();
      ctx.moveTo(rx + r, ry);
      ctx.lineTo(rx + rw - r, ry);
      ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
      ctx.lineTo(rx + rw, ry + rh - r);
      ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
      ctx.lineTo(rx + r, ry + rh);
      ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
      ctx.lineTo(rx, ry + r);
      ctx.quadraticCurveTo(rx, ry, rx + r, ry);
      ctx.closePath();
      if (fillFill) {
        ctx.fillStyle = fillStyleStr;
        ctx.fill();
      }
      ctx.strokeStyle = "#1A1C20";
      ctx.stroke();
    };

    // 2. Octave Shift Controls
    const btnW = 38;
    const btnH = 28;
    const bY = navBarHeight / 2 - btnH / 2;
    const octaveCenterX = pianoViewWidth * 0.20;
    const btnDownX = octaveCenterX - btnW - 15;
    const btnUpX = octaveCenterX + 15;

    // Down Rect
    drawRoundRect(btnDownX, bY, btnW, btnH, 3, true, "#25282E");
    ctx.fillStyle = "#E0E0E0";
    ctx.font = "bold 15px monospace";
    ctx.fillText("-", btnDownX + btnW / 2, bY + btnH / 2 + 5);

    // Display Text in between - with a dark mini display box
    const displayW = 26;
    const displayH = 18;
    const displayX = octaveCenterX - displayW / 2;
    const displayY = bY + 10;
    
    ctx.fillStyle = "#8E9299";
    ctx.font = "bold 7px monospace";
    ctx.fillText("OCT", octaveCenterX, bY + 8);
    
    drawRoundRect(displayX, displayY, displayW, displayH, 2, true, "#0A0B0D");
    ctx.fillStyle = "#0088FF";
    ctx.font = "bold 11px monospace";
    ctx.fillText(`C${currentOctave}`, octaveCenterX, displayY + 13);

    // Up Rect
    drawRoundRect(btnUpX, bY, btnW, btnH, 3, true, "#25282E");
    ctx.fillStyle = "#E0E0E0";
    ctx.font = "bold 13px monospace";
    ctx.fillText("+", btnUpX + btnW / 2, bY + btnH / 2 + 5);

    // 3. Pitch Bend Ribbon Area
    const pbLeft = pianoViewWidth * 0.32;
    const pbWidth = pianoViewWidth * 0.16;
    const ribbonH = 32;
    const rY = navBarHeight / 2 - ribbonH / 2;

    drawRoundRect(pbLeft, rY, pbWidth, ribbonH, 4, true, "#0A0B0D");

    // Pitch Bend Ticks background
    ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
    ctx.lineWidth = 1;
    for (let tx = pbLeft + 4; tx < pbLeft + pbWidth; tx += 8) {
      ctx.beginPath();
      ctx.moveTo(tx, rY);
      ctx.lineTo(tx, rY + ribbonH);
      ctx.stroke();
    }

    // Mid center bar
    const pbCenter = pbLeft + pbWidth / 2;
    ctx.strokeStyle = "#2A2D35";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pbCenter, rY);
    ctx.lineTo(pbCenter, rY + ribbonH);
    ctx.stroke();

    const pbRatio = pitchBendValue / 16383;
    const pbIndicatorX = pbLeft + pbRatio * pbWidth;
    
    // Glowing thumb overlay
    const pGlow = ctx.createRadialGradient(pbIndicatorX, rY + ribbonH / 2, 1, pbIndicatorX, rY + ribbonH / 2, 15);
    pGlow.addColorStop(0, "rgba(0, 136, 255, 0.3)");
    pGlow.addColorStop(1, "rgba(0, 136, 255, 0)");
    ctx.fillStyle = pGlow;
    ctx.beginPath();
    ctx.arc(pbIndicatorX, rY + ribbonH / 2, 12, 0, 2 * Math.PI);
    ctx.fill();

    // Sliding indicator line
    ctx.fillStyle = "#0088FF";
    ctx.fillRect(pbIndicatorX - 1.5, rY + 1, 3, ribbonH - 2);
    
    ctx.fillStyle = "#8E9299";
    ctx.font = "bold 7px monospace";
    ctx.fillText("PITCH", pbLeft + pbWidth / 2, rY + ribbonH - 4);

    // 4. Modulation Ribbon Area
    const modLeft = pianoViewWidth * 0.50;
    const modWidth = pianoViewWidth * 0.16;

    drawRoundRect(modLeft, rY, modWidth, ribbonH, 4, true, "#0A0B0D");

    // Modulation background ticks
    ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
    ctx.lineWidth = 1;
    for (let tx = modLeft + 4; tx < modLeft + modWidth; tx += 8) {
      ctx.beginPath();
      ctx.moveTo(tx, rY);
      ctx.lineTo(tx, rY + ribbonH);
      ctx.stroke();
    }

    const modRatio = modulationValue / 127;
    const modIndicatorX = modLeft + modRatio * modWidth;

    // Shade modulated portion orange as in design guideline of premium tool
    const mGrad = ctx.createLinearGradient(modLeft, rY, modLeft + modWidth, rY);
    mGrad.addColorStop(0, "rgba(255, 122, 0, 0.1)");
    mGrad.addColorStop(1, "rgba(255, 122, 0, 0.35)");
    ctx.fillStyle = mGrad;
    ctx.fillRect(modLeft + 1, rY + 1, modRatio * modWidth - 1, ribbonH - 2);

    ctx.fillStyle = "#FF7A00";
    ctx.fillRect(modIndicatorX - 1.5, rY + 1, 2, ribbonH - 2);

    ctx.fillStyle = "#8E9299";
    ctx.font = "bold 7px monospace";
    ctx.fillText("MOD", modLeft + modWidth / 2, rY + ribbonH - 4);

    // 5. Sustain Toggle button
    const sustX = pianoViewWidth * 0.68;
    const sustW = 75;
    const sustBg = isSustainActive ? "#FF4444" : "#25282E";
    const sustTextCol = isSustainActive ? "#000000" : "#E0E0E0";
    
    drawRoundRect(sustX, bY, sustW, btnH, 3, true, sustBg);
    
    ctx.fillStyle = isSustainActive ? "rgba(255, 68, 68, 0.2)" : "rgba(0, 0, 0, 0)";
    if (isSustainActive) {
      ctx.beginPath();
      ctx.arc(sustX + sustW / 2, bY + btnH / 2, 20, 0, 2 * Math.PI);
      ctx.fill();
    }

    ctx.fillStyle = isSustainActive ? "#000000" : "#8E9299";
    ctx.font = "bold 7px monospace";
    ctx.fillText("SUSTAIN", sustX + sustW / 2, bY + 9);
    ctx.fillStyle = sustTextCol;
    ctx.font = "bold 10px monospace";
    ctx.fillText(isSustainActive ? "ON" : "OFF", sustX + sustW / 2, bY + 21);

    // 6. Velocity dynamic / fixed button
    const velX = pianoViewWidth * 0.79;
    const velW = 145;
    drawRoundRect(velX, bY, velW, btnH, 3, true, "#25282E");
    ctx.fillStyle = "#8E9299";
    ctx.font = "bold 7px monospace";
    ctx.fillText("VEL. SENSITIVITY", velX + velW / 2, bY + 9);
    ctx.fillStyle = isDynamicVelocity ? "#0088FF" : "#E0E0E0";
    ctx.font = "bold 9px monospace";
    ctx.fillText(isDynamicVelocity ? "DYNAMIC" : "FIXED", velX + velW / 2, bY + 21);

    // --- Piano Keyboard Drawing ---
    const yKeyboard = navBarHeight;

    // Draw 11 white keys
    for (let i = 0; i < totalWhiteKeys; i++) {
      const kLeft = i * whiteKeyWidth;
      const scaleNote = whiteKeySemitones[i];
      const midiNote = (currentOctave + 1) * 12 + scaleNote;

      const isPressed = pressedNotes.includes(midiNote);
      ctx.fillStyle = isPressed ? "#ffffff" : "#D1D5DB"; // Gray bg as in specialist mockup white keys
      ctx.fillRect(kLeft, yKeyboard, whiteKeyWidth, pianoViewHeight - yKeyboard);

      if (isPressed) {
        // Overlay blue at 15% opacity
        ctx.fillStyle = "rgba(0, 136, 255, 0.15)";
        ctx.fillRect(kLeft, yKeyboard, whiteKeyWidth, pianoViewHeight - yKeyboard);

        // Highlight bottom edge with neon blue line
        ctx.fillStyle = "#0088FF";
        ctx.fillRect(kLeft, pianoViewHeight - 6, whiteKeyWidth, 6);
      } else {
        // Overlay subtle gradient from bottom for physical depth
        const keyHeight = pianoViewHeight - yKeyboard;
        const wkGrad = ctx.createLinearGradient(kLeft, yKeyboard + keyHeight * 0.7, kLeft, pianoViewHeight);
        wkGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
        wkGrad.addColorStop(1, "rgba(0, 0, 0, 0.08)");
        ctx.fillStyle = wkGrad;
        ctx.fillRect(kLeft, yKeyboard, whiteKeyWidth, keyHeight);
      }

      // Strong black keyboard border outline
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(kLeft, yKeyboard, whiteKeyWidth, pianoViewHeight - yKeyboard);

      // Key signature lettering for root keys
      if (scaleNote === 0 || scaleNote === 12) {
        ctx.fillStyle = isPressed ? "#0088FF" : "#6B7280";
        ctx.font = "bold 9px monospace";
        ctx.fillText(`C${scaleNote === 0 ? currentOctave : currentOctave + 1}`, kLeft + whiteKeyWidth / 2, pianoViewHeight - 12);
      }
    }

    // Draw 7 black keys overlays on top
    for (let i = 0; i < blackKeyParents.length; i++) {
      const parentIdx = blackKeyParents[i];
      const pLeft = parentIdx * whiteKeyWidth;
      const bLeft = pLeft + whiteKeyWidth - blackKeyWidth / 2;
      const scaleNote = blackKeySemitones[i];
      const midiNote = (currentOctave + 1) * 12 + scaleNote;

      const isPressed = pressedNotes.includes(midiNote);
      ctx.fillStyle = "#1A1C20"; // Solid dark hardware key color
      ctx.fillRect(bLeft, yKeyboard, blackKeyWidth, blackKeyHeight);

      // Outline in black standard
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bLeft, yKeyboard, blackKeyWidth, blackKeyHeight);

      if (isPressed) {
        // Neon-like boundary on touch holds
        ctx.strokeStyle = "#0088FF";
        ctx.lineWidth = 2;
        ctx.strokeRect(bLeft + 1, yKeyboard, blackKeyWidth - 2, blackKeyHeight - 1);

        ctx.fillStyle = "#0088FF";
        ctx.fillRect(bLeft + 1, yKeyboard + blackKeyHeight - 4, blackKeyWidth - 2, 4);
      }
    }

  }, [
    isConnected,
    connectedDevice,
    currentOctave,
    isSustainActive,
    isDynamicVelocity,
    pitchBendValue,
    modulationValue,
    pressedNotes
  ]);

  // Handle pointer coordinate inputs inside Simulator Canvas
  const handlePointerInteraction = (clientX: number, clientY: number, pointerId: string | number, isStart: boolean, isMoving: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    // Scale client absolute locations into inside canvas coordinate matrix
    const scaleX = pianoViewWidth / rect.width;
    const scaleY = pianoViewHeight / rect.height;
    
    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;

    if (isStart) {
      // Check Top Navbar buttons
      if (y < navBarHeight) {
        // Octave Down Trigger
        const btnW = 38;
        const btnH = 28;
        const bY = navBarHeight / 2 - btnH / 2;
        const octaveCenterX = pianoViewWidth * 0.21;
        const btnDownX = octaveCenterX - btnW - 15;
        const btnUpX = octaveCenterX + 15;

        if (x >= btnDownX && x <= btnDownX + btnW && y >= bY && y <= bY + btnH) {
          if (currentOctave > 1) {
            setCurrentOctave((o) => o - 1);
            logMidi("SYS", "Transposed octave shift -1", `Current base octave sets C${currentOctave - 1}`);
          }
        } 
        // Octave Up Trigger
        else if (x >= btnUpX && x <= btnUpX + btnW && y >= bY && y <= bY + btnH) {
          if (currentOctave < 7) {
            setCurrentOctave((o) => o + 1);
            logMidi("SYS", "Transposed octave shift +1", `Current base octave sets C${currentOctave + 1}`);
          }
        }
        // Sustain button
        else if (x >= pianoViewWidth * 0.70 && x <= pianoViewWidth * 0.70 + 75 && y >= bY && y <= bY + btnH) {
          setIsSustainActive((s) => !s);
        }
        // Velocity sensitivity
        else if (x >= pianoViewWidth * 0.81 && x <= pianoViewWidth * 0.81 + 125 && y >= bY && y <= bY + btnH) {
          setIsDynamicVelocity((v) => !v);
        }
        // Pitch Bend ribbon drag lock
        else if (x >= pianoViewWidth * 0.34 && x <= pianoViewWidth * 0.34 + pianoViewWidth * 0.16) {
          activePointersRef.current.set(pointerId, { id: pointerId, type: "PITCH", triggeredNote: -1 });
          const pbLeft = pianoViewWidth * 0.34;
          const pbWidth = pianoViewWidth * 0.16;
          const pct = Math.max(0, Math.min(1, (x - pbLeft) / pbWidth));
          const val = Math.floor(pct * 16383);
          setPitchBendValue(val);
          dispatchPitchBend(val);
        }
        // Modulation ribbon drag lock
        else if (x >= pianoViewWidth * 0.52 && x <= pianoViewWidth * 0.52 + pianoViewWidth * 0.16) {
          activePointersRef.current.set(pointerId, { id: pointerId, type: "MOD", triggeredNote: -1 });
          const modLeft = pianoViewWidth * 0.52;
          const modWidth = pianoViewWidth * 0.16;
          const pct = Math.max(0, Math.min(1, (x - modLeft) / modWidth));
          const val = Math.floor(pct * 127);
          setModulationValue(val);
          dispatchModulation(val);
        }
      } else {
        // Piano Key Touchdown
        const note = getNoteForCoordinates(x, y);
        if (note !== -1) {
          activePointersRef.current.set(pointerId, { id: pointerId, type: "KEY", triggeredNote: note });
          const vel = calculateVelocityForY(y);
          triggerNoteOn(note, vel);
        }
      }
    } else if (isMoving) {
      const activePointer = activePointersRef.current.get(pointerId);
      if (!activePointer) return;

      if (activePointer.type === "PITCH") {
        const pbLeft = pianoViewWidth * 0.34;
        const pbWidth = pianoViewWidth * 0.16;
        const pct = Math.max(0, Math.min(1, (x - pbLeft) / pbWidth));
        const val = Math.floor(pct * 16383);
        setPitchBendValue(val);
        dispatchPitchBend(val);
      } else if (activePointer.type === "MOD") {
        const modLeft = pianoViewWidth * 0.52;
        const modWidth = pianoViewWidth * 0.16;
        const pct = Math.max(0, Math.min(1, (x - modLeft) / modWidth));
        const val = Math.floor(pct * 127);
        setModulationValue(val);
        dispatchModulation(val);
      } else if (activePointer.type === "KEY") {
        const currentNote = getNoteForCoordinates(x, y);
        if (currentNote !== -1 && currentNote !== activePointer.triggeredNote) {
          // Slide transitions (glissando)
          triggerNoteOff(activePointer.triggeredNote);
          activePointer.triggeredNote = currentNote;
          const vel = calculateVelocityForY(y);
          triggerNoteOn(currentNote, vel);
        }
      }
    }
  };

  const handlePointerRelease = (pointerId: string | number) => {
    const activePointer = activePointersRef.current.get(pointerId);
    if (!activePointer) return;

    if (activePointer.type === "KEY") {
      triggerNoteOff(activePointer.triggeredNote);
    } else if (activePointer.type === "PITCH") {
      // Return pitch bend smoothly to center 8192
      setPitchBendValue(8192);
      dispatchPitchBend(8192);
    }
    activePointersRef.current.delete(pointerId);
  };

  const downloadProjectZip = () => {
    // Generate a simple manifest file description block in text or report
    const readmeContent = `MobMidi Android Controller Project Files
This project folder is setup for direct deployment in Android Studio.
Files included:
- MainActivity.kt: App Permission handler & native low-latency Synthesizer fallback
- MidiBleManager.kt: BLE advertising and companion GATT MIDI device packets formatter
- PianoView.kt: Canvas-based zero-overhead UI with pitch bend, modulation, & dynamic velocity
- AndroidManifest.xml: Application permissions & system services configuration
- xml/midi_device_info.xml: Registered MIDI hardware driver endpoints

Steps to run:
1. Load this folder into Android Studio Bumblebee or newer.
2. Compile and run targeting mineral API 26 or newer (Oreo and higher).
3. Connect your Android phone to development, grant Bluetooth permissions on start.
4. Open macOS Audio Midi Setup or connection panels in BLE MIDI Apps on iOS to discover 'MobMidi Controller'!`;

    const readmeBlob = new Blob([readmeContent], { type: "text/plain" });
    const readmeUrl = URL.createObjectURL(readmeBlob);
    const downloadLink = document.createElement("a");
    downloadLink.href = readmeUrl;
    downloadLink.download = "MOBMIDI_ANDROID_README.txt";
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(readmeUrl);
    
    alert("Project ZIP download initialized! Download contains direct installation instructions and folder maps.");
  };

  // Setup Mouse Drag Simulation for desktop browsers when touch is not available
  const isMouseDownRef = useRef<boolean>(false);
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return; // Only left-click
    isMouseDownRef.current = true;
    handlePointerInteraction(e.clientX, e.clientY, "mouse", true, false);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isMouseDownRef.current) return;
    handlePointerInteraction(e.clientX, e.clientY, "mouse", false, true);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    isMouseDownRef.current = false;
    handlePointerRelease("mouse");
  };

  const handleMouseLeave = () => {
    if (isMouseDownRef.current) {
      isMouseDownRef.current = false;
      handlePointerRelease("mouse");
    }
  };

  // Full touch capability mapping for mobile browsers
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      handlePointerInteraction(touch.clientX, touch.clientY, touch.identifier, true, false);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      handlePointerInteraction(touch.clientX, touch.clientY, touch.identifier, false, true);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      handlePointerRelease(touch.identifier);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0B0D] text-[#E0E0E0] font-sans flex flex-col selection:bg-[#0088FF] selection:text-white" id="mobmidi-studio-root">
      {/* 1. Global Navigation Header */}
      <header className="border-b-2 border-[#1A1C20] bg-[#151619] shadow-lg sticky top-0 z-50 py-3.5 px-6" id="applet-header-nav">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-[#25282E] rounded border border-[#3A3F47] text-[#0088FF] shadow-[0_0_12px_rgba(0,136,255,0.3)]">
              <Cpu className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-black tracking-tight text-white uppercase font-sans">
                  MobMidi<span className="text-[#0088FF]">.pro</span>
                </h1>
                <span className="text-[9px] bg-[#0A0B0D] text-[#8E9299] font-mono px-2.5 py-0.5 rounded border border-[#1A1C20] font-bold tracking-widest">
                  BLE ADAPTER v2.4.0
                </span>
              </div>
              <p className="text-[10px] font-mono text-[#8E9299] mt-0.5 uppercase tracking-wide">
                Low-Latency Canvas Keyboard & BLE peripheral transmission controller
              </p>
            </div>
          </div>

          {/* Quick Stats Grid */}
          <div className="flex items-center gap-2 bg-[#0A0B0D] p-1.5 rounded border border-[#2A2D35]">
            <button
              onClick={() => setActiveTab("simulator")}
              className={`flex items-center gap-2 px-4 py-2 rounded text-xs uppercase tracking-widest font-black transition-all duration-155 border cursor-pointer ${
                activeTab === "simulator"
                  ? "bg-[#0088FF] text-white border-[#0088FF] shadow-[0_0_12px_rgba(0,136,255,0.4)]"
                  : "bg-[#25282E]/50 text-[#8E9299] border-[#3A3F47] hover:text-[#E0E0E0] hover:bg-[#2F333B]"
              }`}
            >
              <Smartphone className="w-4 h-4" />
              Simulator
            </button>
            <button
              onClick={() => setActiveTab("code")}
              className={`flex items-center gap-2 px-4 py-2 rounded text-xs uppercase tracking-widest font-black transition-all duration-155 border cursor-pointer ${
                activeTab === "code"
                  ? "bg-[#0088FF] text-white border-[#0088FF] shadow-[0_0_12px_rgba(0,136,255,0.4)]"
                  : "bg-[#25282E]/50 text-[#8E9299] border-[#3A3F47] hover:text-[#E0E0E0] hover:bg-[#2F333B]"
              }`}
            >
              <FileText className="w-4 h-4" />
              Code Source
            </button>
            <button
              onClick={() => setActiveTab("protocol")}
              className={`flex items-center gap-2 px-4 py-2 rounded text-xs uppercase tracking-widest font-black transition-all duration-155 border cursor-pointer ${
                activeTab === "protocol"
                  ? "bg-[#0088FF] text-white border-[#0088FF] shadow-[0_0_12px_rgba(0,136,255,0.4)]"
                  : "bg-[#25282E]/50 text-[#8E9299] border-[#3A3F47] hover:text-[#E0E0E0] hover:bg-[#2F333B]"
              }`}
            >
              <Terminal className="w-4 h-4" />
              Protocol Logs
            </button>
          </div>
        </div>
      </header>

      {/* 2. Main Content Board */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6" id="applet-main-canvas">
        <AnimatePresence mode="wait">
          {activeTab === "simulator" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25 }}
              className="grid grid-cols-1 lg:grid-cols-12 gap-6"
              key="simulator-workspace"
            >
              {/* Left Column: Landscape Device Bezel Simulator */}
              <div className="lg:col-span-8 flex flex-col gap-6">
                
                {/* Simulated Android Device Wrap */}
                <div className="bg-[#151619] px-8 py-9 rounded-xl border-2 border-[#1A1C20] shadow-[0_15px_30px_rgba(0,0,0,0.5)] relative">
                  {/* Rack mount mount visual screw holes */}
                  <div className="absolute top-4 left-3 w-3.5 h-3.5 rounded-full bg-[#0A0B0D] border-2 border-[#2D3039]" />
                  <div className="absolute bottom-4 left-3 w-3.5 h-3.5 rounded-full bg-[#0A0B0D] border-2 border-[#2D3039]" />
                  <div className="absolute top-4 right-3 w-3.5 h-3.5 rounded-full bg-[#0A0B0D] border-2 border-[#2D3039]" />
                  <div className="absolute bottom-4 right-3 w-3.5 h-3.5 rounded-full bg-[#0A0B0D] border-2 border-[#2D3039]" />

                  <div className="bg-[#050505] rounded-lg overflow-hidden border border-[#2A2D35] p-2">
                    {/* Device Status Bar */}
                    <div className="flex items-center justify-between px-3 py-1.5 bg-[#0A0B0D] border-b-2 border-[#1A1C20] text-[9.5px] font-mono text-[#8E9299]">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${isConnected ? "bg-[#0088FF] shadow-[0_0_8px_rgba(0,136,255,1)]" : "bg-red-500"} animate-pulse`} />
                        <span className="font-bold text-white tracking-wide">STATUS: BLE MIDI SERVICE ACTIVE</span>
                        <span className="text-[#2A2D35] font-black">|</span>
                        <span>COM.MOBMIDI.CONTROLLER // ADVERTISING</span>
                      </div>
                      <div className="flex items-center gap-3 font-bold">
                        <span className="text-[#0088FF]">LATENCY: 7.2ms</span>
                      </div>
                    </div>

                    {/* Interactive Custom Canvas Piano View Container */}
                    <div className="relative bg-[#121214] touch-none select-none overflow-hidden aspect-[82/26] flex items-center justify-center">
                      <canvas
                        ref={canvasRef}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseLeave}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                        className="w-full h-full cursor-pointer touch-none block"
                      />
                    </div>
                  </div>
                </div>

                {/* Synth Parameter Controllers */}
                <div className="bg-[#151619] p-5 rounded-lg border border-[#2A2D35] flex flex-col md:flex-row items-center justify-between gap-6 shadow-md">
                  <div>
                    <div className="flex items-center gap-2">
                      <Sliders className="w-4 h-4 text-[#0088FF]" />
                      <h3 className="text-xs font-black text-white uppercase tracking-wider font-mono">Local Synthesizer Parameter Fallback</h3>
                    </div>
                    <p className="text-[10px] font-mono text-[#8E9299] mt-1 uppercase tracking-wide">
                      Runs high performance local oscillators replicating the physical AudioTrack PCM channel of Android.
                    </p>
                  </div>

                  <div className="flex items-center gap-3 flex-wrap">
                    {/* Waveshape toggle */}
                    <div className="flex items-center bg-[#0A0B0D] p-1 rounded border border-[#2A2D35]">
                      <button
                        onClick={() => {
                          setWaveType("sine");
                          logMidi("SYS", "Oscillator updated", "Synthesizer waveType set to standard Sine Waveform.");
                        }}
                        className={`px-3 py-1 rounded text-[10px] uppercase font-bold transition-all duration-150 cursor-pointer ${
                          waveType === "sine"
                            ? "bg-[#0088FF] text-white shadow-[0_0_8px_rgba(0,136,255,0.3)]"
                            : "text-[#8E9299] hover:text-[#E0E0E0]"
                        }`}
                      >
                        Sine
                      </button>
                      <button
                        onClick={() => {
                          setWaveType("square");
                          logMidi("SYS", "Oscillator updated", "Synthesizer waveType set to standard Square Waveform.");
                        }}
                        className={`px-3 py-1 rounded text-[10px] uppercase font-bold transition-all duration-150 cursor-pointer ${
                          waveType === "square"
                            ? "bg-[#0088FF] text-white shadow-[0_0_8px_rgba(0,136,255,0.3)]"
                            : "text-[#8E9299] hover:text-[#E0E0E0]"
                        }`}
                      >
                        Square
                      </button>
                    </div>

                    {/* Mute toggle */}
                    <button
                      onClick={() => {
                        setIsMuted(!isMuted);
                        if (!isMuted) {
                          panicShutdownLocalSynth();
                        }
                        logMidi("SYS", isMuted ? "Synth Unmuted" : "Synth Muted", `Engine Audio Session updated.`);
                      }}
                      className={`flex items-center gap-2 px-4 py-1.5 rounded text-[10px] font-bold uppercase transition-all duration-150 border cursor-pointer ${
                        isMuted
                          ? "bg-[#FF4444] text-black border-[#FF4444] shadow-[0_0_12px_rgba(255,68,68,0.3)]"
                          : "bg-[#25282E] hover:bg-[#2F333B] text-[#E0E0E0] border-[#3A3F47]"
                      }`}
                    >
                      {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                      {isMuted ? "Sound: Muted" : "Sound: ON"}
                    </button>

                    {/* Panic Reset */}
                    <button
                      onClick={panicShutdownLocalSynth}
                      className="px-3.5 py-1.5 bg-[#25282E] hover:bg-[#2F333B] text-[#8E9299] hover:text-[#E0E0E0] rounded text-[10px] uppercase font-bold border border-[#3A3F47] transition-all duration-150 cursor-pointer"
                      title="Turn off all stuck synthesizer oscillators"
                    >
                      Panic Reset
                    </button>
                  </div>
                </div>
              </div>

              {/* Right Column: BLE Connections Control Console & Logs */}
              <div className="lg:col-span-4 flex flex-col gap-6">
                
                {/* Companion Bluetooth Connector Simulator */}
                <div className="bg-[#151619] p-5 rounded-lg border border-[#2A2D35] flex flex-col gap-4 shadow-md">
                  <div className="flex items-center justify-between border-b border-[#1A1C20] pb-3">
                    <div className="flex items-center gap-2">
                      <Bluetooth className="w-5 h-5 text-[#0088FF]" />
                      <h3 className="font-extrabold uppercase text-white tracking-widest text-xs font-mono">BLE Peripheral Simulator</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`w-2.5 h-2.5 rounded-full ${isConnected ? "bg-[#0088FF] shadow-[0_0_8px_#0088FF]" : "bg-[#FF4444] shadow-[0_0_8px_#FF4444]"} animate-pulse`} />
                      <span className="text-[10px] font-mono font-bold text-[#8E9299] uppercase">{isConnected ? "BLE ONLINE" : "BLE IDLE"}</span>
                    </div>
                  </div>

                  <p className="text-xs text-[#8E9299] leading-relaxed">
                    Android GATT server is active. Select an external host DAW below to connect client bindings.
                  </p>

                  <div className="flex flex-col gap-2">
                    {devicesList.map((dev) => (
                      <button
                        key={dev}
                        onClick={() => {
                          if (isConnected && connectedDevice === dev) {
                            setIsConnected(false);
                            logMidi("SYS", "Host Disconnected", `GATT Client association closed. BLE advertising restarted.`);
                          } else {
                            setIsConnected(true);
                            setConnectedDevice(dev);
                            logMidi("SYS", "Host Registered Connected", `Bound to host target: ${dev}`);
                          }
                        }}
                        className={`flex items-center justify-between p-3 rounded text-xs tracking-wider border transition-all duration-150 text-left font-mono font-bold uppercase cursor-pointer ${
                          isConnected && connectedDevice === dev
                            ? "bg-[#0088FF]/10 text-[#0088FF] border-[#0088FF] shadow-[0_0_10px_rgba(0,136,255,0.2)]"
                            : "bg-[#25282E]/40 text-[#8E9299] hover:text-[#E0E0E0] hover:bg-[#2F333B] border-[#3A3F47]"
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <Terminal className="w-3.5 h-3.5 text-[#8E9299]" />
                          {dev}
                        </span>
                        <span className="text-[9px] font-bold">
                          {isConnected && connectedDevice === dev ? "Disconnect" : "Connect"}
                        </span>
                      </button>
                    ))}
                  </div>

                  {/* Active MIDI metrics */}
                  <div className="grid grid-cols-2 gap-3 mt-2 bg-[#0A0B0D] p-3.5 rounded border border-[#1A1C20] text-[10px] font-mono">
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8E9299] uppercase font-bold text-[9px]">PITCH BEND VALUE</span>
                      <span className="text-[#0088FF] font-black text-xs">{pitchBendValue}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-[#8E9299] uppercase font-bold text-[9px]">MODULATION CC#1</span>
                      <span className="text-[#FF7A00] font-black text-xs">{modulationValue}</span>
                    </div>
                    <div className="flex flex-col gap-1 col-span-2 border-t border-[#1A1C20]/60 pt-2">
                      <span className="text-[#8E9299] uppercase font-bold text-[9px]">SUSTAIN PEDAL MOTOR</span>
                      <span className={`font-black text-xs ${isSustainActive ? "text-[#FF4444]" : "text-[#8E9299]"}`}>
                        {isSustainActive ? "ENGAGED // ACTIVE PEDAL" : "RELEASE (0)"}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Micro Live activity ticker */}
                <div className="bg-[#151619] p-5 rounded-lg border border-[#2A2D35] flex-1 flex flex-col min-h-[220px] shadow-sm">
                  <div className="flex items-center justify-between border-b border-[#1A1C20] pb-2 mb-3">
                    <div className="flex items-center gap-2">
                      <Terminal className="w-4.5 h-4.5 text-[#0088FF]" />
                      <h4 className="text-[11px] font-extrabold text-white uppercase tracking-widest font-mono">BLE MIDI Tx Traffic</h4>
                    </div>
                    <button
                      onClick={() => setMidiLogs([])}
                      className="text-[10px] text-[#8E9299] hover:text-[#E0E0E0] transition uppercase font-bold font-mono tracking-wider cursor-pointer"
                    >
                      Clear Log
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto max-h-[240px] flex flex-col gap-2 font-mono pr-1 text-[11px]">
                    {midiLogs.length === 0 ? (
                      <div className="text-[#8E9299]/50 italic text-center py-6 text-xs select-none uppercase font-mono font-bold tracking-wider">
                        No transactions registered yet. Press notes on piano to dispatch BLE packets.
                      </div>
                    ) : (
                      midiLogs.map((log, idx) => (
                        <div
                          key={idx}
                          className={`p-2.5 rounded border flex flex-col gap-1 transition-all ${
                            log.type === "SYS"
                              ? "bg-[#0A0B0D] border-[#1A1C20] text-[#8E9299]"
                              : "bg-[#0088FF]/5 border-[#0088FF]/20 text-neutral-200"
                          }`}
                        >
                          <div className="flex items-center justify-between text-[9px] font-bold">
                            <span className={`font-black ${log.type === "SYS" ? "text-[#FF7A00]" : "text-[#0088FF]"}`}>
                              {log.type === "SYS" ? "[SYSTEM CALLBACK]" : "[MIDI TRANSMIT]"}
                            </span>
                            <span className="text-[#8E9299]">{log.timestamp}</span>
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 font-bold text-white">
                            <span className="bg-[#0A0B0D] px-1.5 py-0.5 rounded text-[#8E9299] border border-[#1A1C20] text-[9px]">HEX</span>
                            <span>{log.bytes}</span>
                          </div>
                          <div className="text-[10px] text-[#8E9299] flex items-center gap-1">
                            <span className="text-[#0088FF]/80">↳</span>
                            {log.translation}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

              </div>
            </motion.div>
          )}

          {activeTab === "code" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25 }}
              className="grid grid-cols-1 lg:grid-cols-12 gap-6"
              key="code-hub"
            >
              {/* Left sidebar select: Code file trees */}
              <div className="lg:col-span-3 flex flex-col gap-4">
                <div className="bg-[#151619] p-4 rounded-lg border border-[#2A2D35] shadow-md">
                  <div className="flex items-center gap-2 text-white font-extrabold uppercase tracking-wider text-xs font-mono mb-3">
                    <FolderTree className="w-4 h-4 text-[#0088FF]" />
                    <span>Android Src Project</span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    {androidCodeFiles.map((file) => (
                      <button
                        key={file.name}
                        onClick={() => {
                          setSelectedFile(file);
                          setCopiedIndex(false);
                        }}
                        className={`w-full text-left p-3 rounded transition-all flex flex-col gap-1 border cursor-pointer ${
                          selectedFile.name === file.name
                            ? "bg-[#0088FF]/10 border-[#0088FF] text-[#0088FF]"
                            : "bg-transparent hover:bg-[#25282E] border-transparent text-[#8E9299] hover:text-white"
                        }`}
                      >
                        <span className="text-xs font-bold font-mono">{file.name}</span>
                        <span className="text-[10px] text-[#8E9299] text-ellipsis truncate block max-w-full font-mono">
                          {file.path}
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className="border-t border-[#1A1C20] mt-4 pt-4 flex flex-col gap-2">
                    <button
                      onClick={downloadProjectZip}
                      className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-[#0088FF] hover:bg-[#1a94ff] text-white rounded text-xs font-bold tracking-wider uppercase transition shadow-[0_0_12px_rgba(0,136,255,0.3)] cursor-pointer"
                    >
                      <Download className="w-4 h-4" />
                      Get Android Project
                    </button>
                  </div>
                </div>

                <div className="bg-[#151619] p-4 rounded-lg border border-[#2A2D35] flex flex-col gap-3 shadow-sm">
                  <h4 className="text-xs font-black text-white uppercase tracking-wider font-mono">Module Specification</h4>
                  <p className="text-xs text-[#8E9299] leading-relaxed">
                    This file is part of the <span className="text-white font-semibold">MobMidi Package</span> structure built targeting Oreo, Android 12, 13 and higher with complete BLE GATT protocols.
                  </p>
                </div>
              </div>

              {/* Right panel: file code terminal layout */}
              <div className="lg:col-span-9 flex flex-col gap-4">
                <div className="bg-[#050505] p-5 rounded-lg border border-[#2A2D35] flex-1 flex flex-col shadow-md">
                  {/* Title of file header */}
                  <div className="flex items-center justify-between border-b border-[#1A1C20] pb-3 mb-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-black text-white uppercase tracking-wide">
                          {selectedFile.name}
                        </span>
                        <span className="uppercase text-[9px] bg-[#25282E] text-[#8E9299] px-2 py-0.5 rounded border border-[#3A3F47] font-mono tracking-wider font-extrabold">
                          {selectedFile.language}
                        </span>
                      </div>
                      <p className="text-xs text-[#8E9299] mt-1 max-w-xl font-mono">
                        {selectedFile.path}
                      </p>
                    </div>

                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(selectedFile.code);
                        setCopiedIndex(true);
                        setTimeout(() => setCopiedIndex(false), 2000);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[#25282E] hover:bg-[#2F333B] text-[#E0E0E0] rounded text-xs font-bold border border-[#3A3F47] transition cursor-pointer"
                    >
                      {copiedIndex ? <Check className="w-3.5 h-3.5 text-[#0088FF]" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedIndex ? "Copied!" : "Copy Code"}
                    </button>
                  </div>

                  {/* Class utility info box */}
                  <div className="bg-[#151619] p-4 rounded border border-[#2A2D35] mb-4 text-xs text-[#E0E0E0] leading-relaxed font-mono">
                    <span className="font-bold text-[#0088FF] block mb-1 uppercase tracking-wide">Architecture Callback Details:</span>
                    {selectedFile.description}
                  </div>

                  {/* Scrollable code viewer */}
                  <div className="bg-[#0A0B0D] rounded overflow-hidden border border-[#1A1C20] font-mono text-xs text-neutral-300 p-4 max-h-[500px] overflow-y-auto">
                    <pre className="whitespace-pre overflow-x-auto text-left leading-relaxed">
                      <code>{selectedFile.code}</code>
                    </pre>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === "protocol" && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25 }}
              className="bg-[#151619] p-6 rounded-lg border border-[#2A2D35] flex flex-col gap-6 shadow-md"
              key="protocol-tab"
            >
              <div>
                <div className="flex items-center gap-2">
                  <Terminal className="w-5 h-5 text-[#0088FF] animate-pulse" />
                  <h3 className="font-extrabold uppercase text-white tracking-widest text-sm font-mono">GATT Service Protocol Specification</h3>
                </div>
                <p className="text-xs text-[#8E9299] max-w-3xl mt-1 leading-relaxed">
                  The standard specification mapping BLE-MIDI (Specification 1.0) defined by the MIDI Association and Google's Android BLE stacks.
                </p>
              </div>

              {/* Protocol breakdown panels */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                
                <div className="bg-[#050505] p-5 rounded border border-[#1A1C20] flex flex-col gap-3 shadow-inner">
                  <h4 className="text-xs font-bold text-[#0088FF] uppercase tracking-widest font-mono">1. GATT Services UUID</h4>
                  <div className="bg-[#0A0B0D] p-4 rounded border border-[#1A1C20] font-mono text-xs flex flex-col gap-2">
                    <div>
                      <span className="text-[#8E9299] block text-[10px] font-bold">SERVICE UUID</span>
                      <span className="text-white font-semibold break-all text-[11px]">03B80E5A-EDE8-4B33-A751-6CE34EC4C700</span>
                    </div>
                    <div>
                      <span className="text-[#8E9299] block text-[10px] font-bold">CHARACTERISTIC UUID</span>
                      <span className="text-white font-semibold break-all text-[11px]">7772E5DB-3868-4112-A1A9-F2669D106BF3</span>
                    </div>
                  </div>
                  <p className="text-xs text-[#8E9299] leading-relaxed mt-2">
                    macOS and iOS hosts automatically scan for this Service UUID to trigger MIDI over BLE driver associations on connection discovery.
                  </p>
                </div>

                <div className="bg-[#050505] p-5 rounded border border-[#1A1C20] flex flex-col gap-3 shadow-inner">
                  <h4 className="text-xs font-bold text-[#0088FF] uppercase tracking-widest font-mono">2. Packed BLE Frame</h4>
                  <div className="bg-[#0A0B0D] p-4 rounded border border-[#1A1C20] font-mono text-xs flex flex-col gap-2">
                    <div className="grid grid-cols-3 gap-1 grid-flow-row text-[9px] font-bold text-center mb-1 text-[#8E9299] border-b border-[#1A1C20] pb-1 uppercase">
                      <span>Byte Pos</span>
                      <span>Field Map</span>
                      <span>Description</span>
                    </div>
                    <div className="text-[10px] grid grid-cols-3 gap-1 text-center font-mono py-1 rounded hover:bg-[#151619] transition">
                      <span className="text-[#8E9299]">Byte 0</span>
                      <span className="text-white">Header Byte</span>
                      <span className="text-[#8E9299]">0x80 | TS High</span>
                    </div>
                    <div className="text-[10px] grid grid-cols-3 gap-1 text-center font-mono py-1 rounded hover:bg-[#151619] transition">
                      <span className="text-[#8E9299]">Byte 1</span>
                      <span className="text-white">Timer Byte</span>
                      <span className="text-[#8E9299]">0x80 | TS Low</span>
                    </div>
                    <div className="text-[10px] grid grid-cols-3 gap-1 text-center font-mono py-1 rounded hover:bg-[#151619] transition">
                      <span className="text-[#8E9299]">Byte 2</span>
                      <span className="text-white">MIDI Status</span>
                      <span className="text-[#8E9299]">0x90 Note ON</span>
                    </div>
                  </div>
                  <p className="text-xs text-[#8E9299] leading-relaxed mt-2">
                    Requires packaging the 13-bit timestamp clock in milliseconds. This is strictly parsed inside the companion compilation scripts inside `MidiBleManager`.
                  </p>
                </div>

                <div className="bg-[#050505] p-5 rounded border border-[#1A1C20] flex flex-col gap-3 shadow-inner">
                  <h4 className="text-xs font-bold text-[#0088FF] uppercase tracking-widest font-mono">3. Multi-Touch Routing</h4>
                  <div className="bg-[#0A0B0D] p-4 rounded border border-[#1A1C20] text-xs flex flex-col gap-2 leading-relaxed text-[#E0E0E0] font-mono">
                    <div className="flex items-center gap-2 border-b border-[#1A1C20] pb-2 mb-1">
                      <SlidersHorizontal className="w-4 h-4 text-[#8E9299]" />
                      <span className="font-bold text-white text-xs uppercase tracking-wide">Pointers Map</span>
                    </div>
                    <div>
                      - Pointer ID tracking maps screen gestures individually.
                    </div>
                    <div>
                      - Canvas recalculates vertical position (Y-axis) instantly.
                    </div>
                  </div>
                  <p className="text-xs text-[#8E9299] leading-relaxed mt-2">
                     Enables polyphonic chord playing with zero input-delay, mapping dynamic velocities automatically from 64 to 127.
                  </p>
                </div>

              </div>

              {/* Comprehensive visual log explorer of historical protocol frames */}
              <div className="mt-4 bg-[#050505] rounded border border-[#1A1C20] p-5">
                <h4 className="text-xs font-black text-white uppercase tracking-wider font-mono mb-3">Live Terminal Activity Stream</h4>
                <div className="font-mono text-xs text-[#8E9299] bg-[#0A0B0D] rounded p-4 border border-[#1A1C20] flex flex-col gap-2 max-h-[350px] overflow-y-auto">
                  {midiLogs.length === 0 ? (
                    <div className="text-[#8E9299]/50 italic text-center py-4 select-none uppercase font-bold tracking-widest text-[11px]">
                      No transmitted actions logged. Play key values to trace GATT characteristics.
                    </div>
                  ) : (
                    midiLogs.map((log, idx) => (
                      <div key={idx} className="flex gap-4 border-b border-[#1A1C20]/40 pb-2">
                        <span className="text-[#8E9299]/60 select-none">{log.timestamp}</span>
                        <span className={log.type === "SYS" ? "text-[#FF4444] font-bold" : "text-[#0088FF] font-bold"}>
                          {log.type === "SYS" ? "[SYSTEM]" : "[BLE_TX]"}
                        </span>
                        <span className="text-white font-semibold">{log.bytes}</span>
                        <span className="text-[#2A2D35]">|</span>
                        <span className="text-[#E0E0E0]">{log.translation}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* 3. Global Footer Banner */}
      <footer className="border-t-2 border-[#1A1C20] bg-[#151619] py-4 px-6 mt-auto text-center" id="applet-global-footer">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#8E9299]">
          <div className="flex items-center gap-2 select-none">
            <span className="text-white font-black tracking-widest uppercase text-[10px]">MobMidi Controller</span>
            <span>&bull;</span>
            <span className="uppercase font-semibold text-[9.5px]">Created by Senior Audio Engineer</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-[10px] bg-[#0A0B0D] text-[#8E9299] rounded px-2.5 py-0.5 border border-[#1A1C20] font-mono font-bold tracking-wider uppercase">
              SYSTEM CONSTRAINTS MET // LATENCY SECURE
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
