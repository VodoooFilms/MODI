# MODI MobMIDI ProGuard Rules
# Retain Bluetooth and MIDI related classes

# Keep Kotlin metadata
-keepattributes *Annotation*
-keepattributes RuntimeVisibleAnnotations
-keepattributes Signature

# Keep Kotlin companion objects
-keepclassmembers class ** {
    public static ** Companion;
}

# Keep Bluetooth BLE classes (Android framework - should be preserved by default but being explicit)
-keep class android.bluetooth.** { *; }
-keep interface android.bluetooth.** { *; }

# Keep MIDI Manager and related classes
-keep class com.mobmidi.controller.MidiBleManager { *; }
-keep class com.mobmidi.controller.BleMidiForegroundService { *; }
-keep class com.mobmidi.controller.PianoView { *; }
-keep class com.mobmidi.controller.MainActivity { *; }

# Keep ConnectionStatusListener interface
-keep interface com.mobmidi.controller.MidiBleManager$ConnectionStatusListener { *; }
-keep interface com.mobmidi.controller.PianoView$MidiEventListener { *; }

# Keep ConcurrentLinkedQueue and other concurrency classes used in BLE manager
-keep class java.util.concurrent.ConcurrentLinkedQueue { *; }
-keep class java.util.concurrent.ConcurrentHashMap { *; }

# Prevent obfuscation of exception messages for debugging
-keepclassmembers class * extends java.lang.Exception {
    public static **[] getSupportedExtensions();
}

# Keep Log tags for release builds (optional - remove if you want to strip logs)
-keepclassmembers class ** {
    public static *** TAG;
}
