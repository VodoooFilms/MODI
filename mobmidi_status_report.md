# MobMIDI Project - Status Report & Troubleshooting

**Fecha:** 23 de Mayo de 2026
**Proyecto:** mobMIDI (Controlador MIDI BLE para Android/iOS)

---

## 🛑 Issues Resueltos (Bluetooth LE MIDI)

**Problema Original:** 
El dispositivo Android era visible en la configuración "Audio MIDI Setup" de macOS, pero la conexión nunca terminaba de establecerse de forma persistente y no era reconocido por GarageBand o DAWs.

**Causa Raíz (Root Cause):**
El UUID de la característica MIDI en el servidor GATT de Android tenía un error tipográfico (`7772EE0F-3824-32E1-807E-9CEF5A744317`). Aunque el UUID del servicio principal era correcto (lo que permitía que el Mac viera el dispositivo), el Mac abortaba la conexión al no encontrar la característica específica para suscribirse a las notificaciones (notas MIDI).

**Solución Implementada:**
Se modificó el UUID al estándar oficial dictado por la asociación MIDI para Bluetooth LE:
- **Service UUID:** `03B80E5A-EDE8-4B33-A751-6CE34EC4C700` (Mantenido)
- **Characteristic UUID:** `7772E5DB-3868-4112-A1A9-F2669D106BF3` (Corregido)

*Archivos modificados:*
- `android/app/src/main/java/com/mobmidi/controller/MidiBleManager.kt`
- `src/data.ts` (Actualizado para reflejar la UI del código mockup)

---

## 🛠️ Hints & Consejos para el Futuro

### 1. Compilación del APK en Mac (Sin Android Studio abierto)
Si necesitas volver a compilar el APK en el futuro y tienes problemas con Java:
- Asegúrate de tener JDK instalado (Ej: `brew install openjdk@17`).
- Exporta tu variable de entorno: `export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"`
- Compila con: `./gradlew assembleDebug` dentro del directorio `/android`.
- El APK se generará en: `android/app/build/outputs/apk/debug/app-debug.apk`.

### 2. Problemas Instalando el APK (Google Drive)
Google Drive es conocido por causar problemas al distribuir APKs "debug" generados localmente.
- **"App not installed" (Aplicación no instalada):** Generalmente ocurre cuando intentas instalar una versión debug sobre otra versión previa con diferentes firmas. **Hint:** Desinstala siempre la app de mobMIDI vieja primero antes de instalar el nuevo APK.
- **"Parse Error" (Error de análisis de paquete):** Drive suele cambiar el tipo MIME del archivo durante la subida/descarga, corrompiéndolo. **Hint:** Usa los tres puntos (`⋮`) en Drive y dale a **Descargar**. Luego instálalo desde la app "Descargas" o "Files" nativa del teléfono.
- **Mejor alternativa:** Transferir el archivo mediante Telegram/WhatsApp (mensajes guardados), o por cable USB configurado en "Transferencia de archivos".

### 3. Siguientes pasos en el Desarrollo
- Cuando el Mac y GarageBand reconozcan exitosamente el dispositivo, revisa los logs de Android (Logcat) para asegurar que la latencia (Timestamp de 13-bits) se esté enviando sin delays.
- Si hay latencia, asegúrate de que el teléfono Android soporte Bluetooth 5.0+ y que la publicidad BLE siga seteada en `AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY`.
