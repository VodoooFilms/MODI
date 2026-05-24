# MODI

![MODI logo](public/modi-logo.png)

Controlador **MIDI over BLE** open source para Android, pensado para tocar desde el celular con baja latencia, multitouch real y controles expresivos listos para performance.

## Resumen

`MODI` nacio como `mobMIDI`, pero hoy apunta a algo mas claro: convertir un telefono Android en un instrumento/controlador BLE MIDI serio, portable y hackeable, compatible con hosts como GarageBand, Audio MIDI Setup en macOS y otros entornos con soporte para Bluetooth LE MIDI.

## Features

- teclado multitouch de 1.5 octavas
- selector de layouts dentro de la app
- pantalla `Piano` con ribbons expresivos
- pantalla `Drum Pads` con grilla 3x3
- control de nivel por fila en `Drum Pads`
- rack lateral de FX en `Drum Pads` (`Filter`, `Reverb`, `Delay`, `Drive`)
- pantalla `Pads + XY Mod` con 6 pads y modulador bidimensional
- envio de `Note On` / `Note Off` por BLE MIDI
- `pitch bend`
- `mod wheel`
- `sustain`
- cambio de octava
- velocidad `dynamic` o `fixed`
- compactacion de eventos continuos para mejor feel en tiempo real
- advertising BLE MIDI como periferico Android
- servicio foreground para mantener la sesion BLE mas estable
- UI nativa en `Canvas` para reducir latencia tactil
- captura tactil con historico de movimiento para mejorar glissandos y ribbons

## Estado

Hoy el proyecto ya puede:

- anunciarse como dispositivo BLE MIDI en Android
- conectarse desde `Audio MIDI Setup` en macOS
- usarse con GarageBand y hosts compatibles
- enviar notas, sustain, bend y modulacion
- enviar controles por `CC` desde pads, sliders y superficie `XY`
- alternar entre superficies de control sin salir de la vista principal
- mostrar estado de transporte BLE en app y notificacion

## Demo Visual

- Logo principal: [public/modi-logo.png](public/modi-logo.png)
- Favicon / PWA iconos: [public/favicon.png](public/favicon.png), [public/icon-192.png](public/icon-192.png), [public/icon-512.png](public/icon-512.png)
- APK local compartible: [share/MODI-v1.3-release.apk](share/MODI-v1.3-release.apk)
- QR local de instalacion: [share/modi-apk-qr.png](share/modi-apk-qr.png)

## Stack

- Kotlin
- Android SDK 34
- Bluetooth LE MIDI
- `GATT server` + advertising BLE
- `Canvas` nativo para UI tactil
- Vite + React para el simulador/documentacion web del repo

## Estructura Principal

- [android/app/src/main/java/com/mobmidi/controller/MainActivity.kt](android/app/src/main/java/com/mobmidi/controller/MainActivity.kt)
- [android/app/src/main/java/com/mobmidi/controller/BleMidiForegroundService.kt](android/app/src/main/java/com/mobmidi/controller/BleMidiForegroundService.kt)
- [android/app/src/main/java/com/mobmidi/controller/MidiBleManager.kt](android/app/src/main/java/com/mobmidi/controller/MidiBleManager.kt)
- [android/app/src/main/java/com/mobmidi/controller/PianoView.kt](android/app/src/main/java/com/mobmidi/controller/PianoView.kt)
- [src/App.tsx](src/App.tsx)

## Layouts Actuales

- `Piano`: teclado de 1.5 octavas con `pitch bend`, `modulation`, `sustain`, cambio de octava y velocity dinamica/fija
- `Drum Pads`: 9 pads con mapeo por nota, 3 controles de nivel por fila y 4 faders de FX por `CC`
- `Pads + XY Mod`: 6 pads asignados a notas y una superficie `XY` para modular dos `CC` en tiempo real

## Mapeo MIDI Actual

- Drum pads: `36, 38, 42, 39, 41, 43, 45, 47, 49`
- Drum FX: `CC74`, `CC91`, `CC94`, `CC71`
- Hybrid pads: `48, 50, 52, 53, 55, 57`
- XY mod: `X -> CC1`, `Y -> CC74`

## Requisitos

- Android 8.0+ (`minSdk 26`)
- Bluetooth LE
- Java 17 para compilar el APK
- macOS o software/DAW con soporte BLE MIDI si quieres usarlo como controlador externo

## Desarrollo Web

```bash
npm install
npm run dev
```

Build de verificacion:

```bash
npm run build
```

## Compilar APK

Desde la carpeta `android`:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew assembleRelease
```

APK generado:

```text
android/app/build/outputs/apk/release/app-release.apk
```

## Instalar En El Celular

Si quieres compartir una build por red local:

```bash
cd share
python3 -m http.server 8081 --bind 0.0.0.0
```

Luego abre desde el telefono la URL local correspondiente o escanea el QR generado en `share/modi-apk-qr.png`.

Rutas locales utiles:

- `http://<tu-ip-local>:8081/`
- `http://<tu-ip-local>:8081/app.apk`
- `http://<tu-ip-local>:8081/latest.apk`

## Roadmap

- mejorar estabilidad de advertising BLE en mas dispositivos
- reforzar diagnostico y visibilidad del estado de conexion
- afinar mas el comportamiento en tiempo real bajo carga tactil
- presets de layout / escalas
- reasignacion editable de pads, faders y superficie XY
- ampliar rango de teclado
- explorar USB MIDI
- hacer mas pruebas reales en vivo

## Contribuir

Si quieres aportar:

- abre un issue con el bug o la idea
- propone mejoras de latencia, BLE o UX musical
- prueba en distintos telefonos Android
- comparte feedback de uso real en ensayo o escenario

Las contribuciones pequenas tambien sirven mucho: logs, edge cases, ideas de layout y reportes de compatibilidad.

## Filosofia Open Source

`MODI` esta hecho para musicos, makers y developers que quieran:

- tocar desde el celular
- modificar el layout
- experimentar con nuevos gestos
- adaptar el controlador a su propio workflow

El objetivo no es esconder el instrumento detras de una app cerrada, sino abrirlo para iterar, estudiar y tocar mejor.

## Licencia

Este proyecto se distribuye bajo la licencia **MIT**. Revisa [LICENSE](LICENSE).
