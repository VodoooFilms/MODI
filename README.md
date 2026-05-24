# MODI

`MODI` es un controlador MIDI open source para usar desde el celular como instrumento de performance en tiempo real. Nacio como `mobMIDI`, y la idea del proyecto sigue siendo la misma: convertir un telefono Android en un controlador BLE MIDI serio, portable y rapido, compatible con software como GarageBand, Audio MIDI Setup en macOS y otros hosts BLE MIDI.

## Que hace

- teclado tactil multitouch de 1.5 octavas
- envio de `Note On` / `Note Off` por BLE MIDI
- `pitch bend`
- `mod wheel`
- `sustain`
- cambio de octava
- modo de velocidad `dynamic` o `fixed`
- conexion BLE MIDI directa con macOS y DAWs compatibles

## Objetivo del proyecto

Construir un controlador MIDI mobile que no se sienta como demo, sino como instrumento:

- rapido al tocar
- estable al conectarse
- usable en ensayo, composicion y performance
- completamente hackeable y extensible

## Estado actual

El proyecto ya puede:

- anunciarse como dispositivo BLE MIDI en Android
- conectarse desde `Audio MIDI Setup` en macOS
- usarse con GarageBand
- enviar notas, sustain, bend y modulacion

Trabajo reciente incluido:

- correccion de multitouch para evitar `Note Off` prematuros
- mejor manejo al arrastrar el dedo fuera del teclado
- limpieza del `Manifest` Android
- servicio `ForegroundService` para sostener BLE MIDI de forma mas robusta
- watchdog interno para reintentar advertising BLE
- estado visible de transporte BLE en app y notificacion

## Stack tecnico

- Android nativo en Kotlin
- Bluetooth LE MIDI (`GATT server` + advertising BLE)
- UI custom dibujada en `Canvas` para minimizar latencia tactil
- proyecto web auxiliar con Vite/React dentro del repo

## Estructura importante

- [MainActivity.kt](/Users/antoin/Documents/mobMIDI_project/mobmidi/android/app/src/main/java/com/mobmidi/controller/MainActivity.kt)
  Entrada principal de la app y puente entre UI y servicio BLE.
- [BleMidiForegroundService.kt](/Users/antoin/Documents/mobMIDI_project/mobmidi/android/app/src/main/java/com/mobmidi/controller/BleMidiForegroundService.kt)
  Servicio persistente para mantener vivo el controlador BLE MIDI.
- [MidiBleManager.kt](/Users/antoin/Documents/mobMIDI_project/mobmidi/android/app/src/main/java/com/mobmidi/controller/MidiBleManager.kt)
  Advertising, GATT, conexion BLE y envio de mensajes MIDI.
- [PianoView.kt](/Users/antoin/Documents/mobMIDI_project/mobmidi/android/app/src/main/java/com/mobmidi/controller/PianoView.kt)
  Interfaz tactil del teclado y controles expresivos.

## Requisitos

- Android 8.0+ (`minSdk 26`)
- Bluetooth LE
- macOS o software que soporte BLE MIDI si quieres usarlo como controlador externo
- Java 17 para compilar el APK

## Compilar el APK

Desde la carpeta `android`:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew assembleDebug
```

APK generado:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Instalar en el celular

Si ya tienes un server local sirviendo la build, abre el APK desde el navegador del telefono. Si no:

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

Luego abre desde el celular:

```text
http://TU_IP_LOCAL:8080/mobmidi-latest.apk
```

## Conectar con GarageBand en macOS

1. Instala y abre `MODI` en el telefono.
2. Acepta permisos de Bluetooth.
3. Deja la app abierta.
4. En macOS abre `Audio MIDI Setup`.
5. Entra a configuracion Bluetooth MIDI.
6. Busca el telefono y conecta.
7. Abre GarageBand y selecciona una pista de instrumento.
8. Toca desde el celular.

## Problemas conocidos

- BLE MIDI en Android sigue siendo sensible al comportamiento del sistema y al manejo de energia del telefono.
- La estabilidad final depende bastante del dispositivo Android y su stack Bluetooth.
- Si el telefono deja de anunciarse, macOS lo mostrara como `Offline` o dejara de verlo.
- El objetivo actual es seguir endureciendo el servicio BLE para uso mas confiable en vivo.

## Roadmap

- mejorar estabilidad de advertising BLE en mas dispositivos
- agregar diagnostico de conexion mas claro
- mejorar priorizacion de eventos expresivos frente a rafagas de notas
- presets de layout / escalas
- mas rango de teclado
- opcion de USB MIDI
- pruebas reales en vivo y afinacion de latencia

## Filosofia open source

`MODI` esta pensado como herramienta abierta para musicos, makers y developers que quieran:

- tocar desde el celular
- modificar el layout
- experimentar con nuevos gestos
- adaptar el controlador a su propio workflow

Si quieres usarlo, mejorarlo o bifurcarlo, esa es justamente la idea.
