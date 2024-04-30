---
layout: post
title: Flutter 플랫폼 채널(Platform Channel)로 네이티브 기능 호출하기
date: 2024-04-30
tags: [flutter]
description: MethodChannel, EventChannel, BasicMessageChannel의 동작 방식과 코덱, 스레드 규칙, 오류 처리, Pigeon을 통한 타입 안전한 대안을 정리한다.
---

Flutter의 Dart 코드는 Android의 `StatFs`나 iOS의 `AVFoundation` 같은 플랫폼 API를 직접 호출할 수 없다. 플러그인이 없는 기능이 필요하거나, 기존 네이티브 SDK를 연결해야 할 때 쓰는 기본 장치가 플랫폼 채널이다. 이 글은 세 종류의 채널, 메시지가 직렬화되는 방식, 스레드 규칙, 오류 처리, 그리고 문자열 기반 채널의 약점을 보완하는 Pigeon을 다룬다.

## 동작 원리

플랫폼 채널은 Flutter 앱(클라이언트)과 호스트 플랫폼 코드 사이에서 메시지를 주고받는 이름 붙은 통로다. Dart 쪽과 네이티브 쪽이 같은 채널 이름과 같은 코덱(codec)을 쓰면, 한쪽에서 보낸 값이 바이너리로 인코딩되어 `BinaryMessenger`를 거쳐 다른 쪽에서 디코딩된다.

- 메시지와 응답은 **비동기**로 전달된다. UI가 응답을 기다리며 멈추지 않도록 하기 위해서다.
- 채널은 이름으로 식별된다. 같은 이름의 채널을 두 곳에서 만들면 서로 간섭하므로, `com.example.app/storage`처럼 도메인 접두사를 붙인다.
- 양쪽 코덱이 호환되지 않으면 값을 해석하지 못한다.

## 세 종류의 채널

| 채널 | 통신 형태 | 기본 코덱 | 용도 |
|---|---|---|---|
| `MethodChannel` | 메서드 이름 + 인자 → 단일 결과 | `StandardMethodCodec` | 함수 호출 형태의 일회성 요청 |
| `EventChannel` | 구독 → 연속 이벤트 스트림 | `StandardMethodCodec` | 센서, 충전 상태, 진행률처럼 계속 바뀌는 값 |
| `BasicMessageChannel<T>` | 메시지 ↔ 응답 | 생성 시 지정(`StandardMessageCodec`, `StringCodec` 등) | 메서드 구분이 필요 없는 단순 메시지 교환 |

`MethodChannel`은 양방향이다. 네이티브 쪽에서도 `invokeMethod`로 Dart에 등록된 핸들러를 호출할 수 있다.

## 코덱과 지원 타입

`MethodChannel`과 `EventChannel`이 기본으로 쓰는 `StandardMethodCodec`은 내부적으로 `StandardMessageCodec`으로 값을 직렬화한다. 지원 타입은 다음과 같다.

| Dart | Kotlin | Swift |
|---|---|---|
| `null` | `null` | `nil` (중첩 시 `NSNull`) |
| `bool` | `Boolean` | `NSNumber(value: Bool)` |
| `int` (32비트 이하) | `Int` | `NSNumber(value: Int32)` |
| `int` (32비트 초과) | `Long` | `NSNumber(value: Int)` |
| `double` | `Double` | `NSNumber(value: Double)` |
| `String` | `String` | `String` |
| `Uint8List` | `ByteArray` | `FlutterStandardTypedData(bytes: Data)` |
| `Int32List` | `IntArray` | `FlutterStandardTypedData(int32: Data)` |
| `Int64List` | `LongArray` | `FlutterStandardTypedData(int64: Data)` |
| `Float64List` | `DoubleArray` | `FlutterStandardTypedData(float64: Data)` |
| `List` | `List` | `Array` |
| `Map` | `HashMap` | `Dictionary` |

여기서 주의할 두 가지가 있다.

첫째, Dart의 `int`는 값의 크기에 따라 Kotlin에서 `Int` 또는 `Long`으로 도착한다. 파일 크기처럼 커질 수 있는 값을 `call.argument<Int>("size")`로 받으면 큰 값에서 `ClassCastException`이 난다. 정수는 `Number`로 받아 `toLong()`으로 변환하는 편이 안전하다.

둘째, Dart 쪽 반환 타입 지정에 제약이 있다. `invokeMethod<T>`의 `T`에는 `dynamic` 외의 제네릭 클래스를 쓸 수 없다. `Map<String, String>`은 지원되지 않고 `Map<dynamic, dynamic>`이나 `Map`으로 받아야 한다. 타입이 맞지 않으면 런타임에 `TypeError`가 발생한다. 리스트와 맵은 `invokeListMethod`, `invokeMapMethod`로 받으면 캐스팅이 간단해진다.

## MethodChannel 예제

기기의 남은 저장 공간을 조회해, 영상 저장 전에 공간이 충분한지 확인하는 예제다.

```dart
class StorageChannel {
  static const _channel = MethodChannel('com.example.app/storage');

  Future<int> freeBytes() async {
    try {
      final bytes = await _channel.invokeMethod<int>('getFreeBytes');
      return bytes ?? 0;
    } on PlatformException catch (e) {
      throw StorageException(e.code, e.message);
    } on MissingPluginException {
      throw StorageException('UNSUPPORTED', 'Not implemented on this platform');
    }
  }
}
```

Android에서는 `MainActivity`의 `configureFlutterEngine`에서 핸들러를 등록한다.

```kotlin
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/storage")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "getFreeBytes" -> {
                        try {
                            result.success(StatFs(filesDir.path).availableBytes)
                        } catch (e: IllegalArgumentException) {
                            result.error("STAT_FAILED", e.message, null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }
}
```

iOS에서는 `AppDelegate`에서 `FlutterViewController`의 `binaryMessenger`로 채널을 만든다.

```swift
@UIApplicationMain
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let controller = window?.rootViewController as! FlutterViewController
    let channel = FlutterMethodChannel(name: "com.example.app/storage",
                                       binaryMessenger: controller.binaryMessenger)
    channel.setMethodCallHandler { call, result in
      switch call.method {
      case "getFreeBytes":
        do {
          let values = try URL(fileURLWithPath: NSHomeDirectory())
            .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
          result(values.volumeAvailableCapacityForImportantUsage ?? 0)
        } catch {
          result(FlutterError(code: "STAT_FAILED", message: error.localizedDescription, details: nil))
        }
      default:
        result(FlutterMethodNotImplemented)
      }
    }
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
```

## 오류 처리

Dart의 `invokeMethod`가 던지는 예외는 두 가지다.

| 네이티브 쪽 | Dart 쪽 결과 |
|---|---|
| `result.success(value)` / `result(value)` | `Future`가 값으로 완료(null 가능) |
| `result.error(code, message, details)` / `result(FlutterError(...))` | `PlatformException(code, message, details)` |
| `result.notImplemented()` / `result(FlutterMethodNotImplemented)` | `MissingPluginException` |
| 핸들러 미등록 | `MissingPluginException` |

`details`에는 코덱이 지원하는 타입만 넣을 수 있다. `code`는 Dart 쪽에서 분기할 수 있도록 고정된 문자열 상수로 정하고, 사람이 읽는 설명은 `message`에 둔다.

`result`는 **정확히 한 번** 호출해야 한다. 분기 하나에서 호출을 빠뜨리면 Dart 쪽 `Future`가 영원히 완료되지 않는다. 두 번 호출하는 것도 오류다. 비동기 콜백 안에서 결과를 돌려줄 때 특히 주의한다.

## EventChannel 예제

충전 상태처럼 계속 바뀌는 값은 `EventChannel`로 스트림을 연다. Dart에서 `receiveBroadcastStream()`을 구독하면 네이티브의 `onListen`이, 마지막 구독이 취소되면 `onCancel`이 호출된다.

```dart
const _charging = EventChannel('com.example.app/charging');

Stream<bool> chargingStream() =>
    _charging.receiveBroadcastStream().map((event) => event == 'charging');
```

```kotlin
EventChannel(flutterEngine.dartExecutor.binaryMessenger, "com.example.app/charging")
    .setStreamHandler(object : EventChannel.StreamHandler {
        private var receiver: BroadcastReceiver? = null

        override fun onListen(arguments: Any?, events: EventChannel.EventSink) {
            receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    when (intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
                        BatteryManager.BATTERY_STATUS_CHARGING -> events.success("charging")
                        BatteryManager.BATTERY_STATUS_FULL -> events.success("full")
                        BatteryManager.BATTERY_STATUS_DISCHARGING -> events.success("discharging")
                        else -> events.error("UNAVAILABLE", "Charging status unavailable", null)
                    }
                }
            }
            registerReceiver(receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        }

        override fun onCancel(arguments: Any?) {
            unregisterReceiver(receiver)
            receiver = null
        }
    })
```

`EventSink.error`로 보낸 오류는 Dart 스트림에 `PlatformException` 오류 이벤트로 도착하고, `endOfStream()`을 호출하면 스트림이 닫힌다. Android 문서는 `onListen`과 `onCancel`이 번갈아 여러 번 호출될 수 있으며, 활성 스트림이 없을 때는 리소스를 쓰지 않도록 구현하라고 한다. 리시버나 센서 리스너는 반드시 `onCancel`에서 해제한다.

## 스레드 규칙

Flutter 문서의 스레드 규칙은 방향별로 다르다.

| 상황 | 규칙 |
|---|---|
| 네이티브 → Dart 채널 호출(`invokeMethod`, `EventSink`) | 플랫폼의 메인 스레드에서 호출해야 함 |
| Dart → 네이티브 호출 | 루트 isolate, 또는 등록된 백그라운드 isolate에서 가능 |
| 네이티브 핸들러 실행 위치 | 기본은 플랫폼 메인 스레드, 태스크 큐(Task Queue)를 지정하면 백그라운드 스레드 |

핸들러가 기본적으로 메인 스레드에서 실행된다는 점이 중요하다. 핸들러 안에서 파일을 읽거나 영상을 변환하면 네이티브 UI가 멈춘다. 오래 걸리는 작업은 다른 스레드로 넘기고, 결과는 메인 스레드로 돌아와서 전달한다. Android의 `MethodChannel.Result` 문서는 모든 메서드를 어느 스레드에서나 호출할 수 있다고 하지만, 네이티브에서 Dart를 호출하는 경우와 규칙을 맞추기 위해 메인 스레드로 돌아와 응답하는 습관이 안전하다.

```kotlin
"compress" -> {
    val path = call.argument<String>("path")!!
    executor.execute {
        val output = runCatching { compressor.compress(path) }
        Handler(Looper.getMainLooper()).post {
            output.fold(
                onSuccess = { result.success(it) },
                onFailure = { result.error("COMPRESS_FAILED", it.message, null) },
            )
        }
    }
}
```

iOS에서는 `DispatchQueue.main.async`로 메인 큐에 돌아온다.

핸들러 자체를 백그라운드에서 실행하려면 `BinaryMessenger`의 태스크 큐를 쓴다. Android에서는 `makeBackgroundTaskQueue()`로 만든 큐를 채널 생성자의 네 번째 인자로, iOS에서는 `makeBackgroundTaskQueue?()`의 결과를 `taskQueue:` 인자로 넘긴다. 공식 예제는 플러그인의 `onAttachedToEngine`에서 `FlutterPluginBinding`의 `binaryMessenger`로 이 큐를 만든다.

```kotlin
val taskQueue = binding.binaryMessenger.makeBackgroundTaskQueue()
val channel = MethodChannel(
    binding.binaryMessenger, "com.example.app/storage",
    StandardMethodCodec.INSTANCE, taskQueue,
)
```

Dart 쪽에서 백그라운드 isolate가 채널을 쓰려면 루트 isolate의 `RootIsolateToken.instance`를 넘겨받아 `BackgroundIsolateBinaryMessenger.ensureInitialized(token)`를 먼저 호출해야 한다.

## Pigeon: 타입 안전한 대안

문자열 채널의 약점은 메서드 이름, 인자 키, 타입을 세 언어에서 각각 손으로 맞춰야 한다는 것이다. 오타는 컴파일 시점이 아니라 런타임에 `MissingPluginException`이나 캐스팅 오류로 드러난다.

Pigeon은 Dart로 작성한 인터페이스 정의에서 Dart, Kotlin, Java, Swift, Objective-C, C++ 코드를 생성하는 공식 코드 생성기다. 생성된 코드는 내부적으로 `BasicMessageChannel`을 사용한다. 정의 파일은 `lib` 바깥에 둔다.

```dart
import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(PigeonOptions(
  dartOut: 'lib/src/storage_api.g.dart',
  kotlinOut: 'android/app/src/main/kotlin/com/example/app/StorageApi.g.kt',
  swiftOut: 'ios/Runner/StorageApi.g.swift',
))
class ExportRequest {
  ExportRequest({required this.path, required this.maxBytes});
  String path;
  int maxBytes;
}

@HostApi()
abstract class StorageApi {
  int getFreeBytes();

  @async
  String export(ExportRequest request);
}
```

```bash
flutter pub run pigeon --input pigeons/storage_api.dart
```

생성된 인터페이스를 구현하고 `setUp`으로 등록한다. Dart의 `int`는 Kotlin `Long`, Swift `Int64`로 생성되고, `@async` 메서드는 콜백(`callback`, `completion`)으로 결과를 돌려주는 시그니처가 된다.

```kotlin
private class StorageApiImpl(private val context: Context) : StorageApi {
    override fun getFreeBytes(): Long = StatFs(context.filesDir.path).availableBytes

    override fun export(request: ExportRequest, callback: (Result<String>) -> Unit) {
        callback(Result.failure(FlutterError("UNSUPPORTED", "Not implemented yet", null)))
    }
}

StorageApi.setUp(flutterEngine.dartExecutor.binaryMessenger, StorageApiImpl(this))
```

```swift
private class StorageApiImpl: StorageApi {
  func getFreeBytes() throws -> Int64 {
    let values = try URL(fileURLWithPath: NSHomeDirectory())
      .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return values.volumeAvailableCapacityForImportantUsage ?? 0
  }

  func export(request: ExportRequest, completion: @escaping (Result<String, Error>) -> Void) {
    completion(.failure(FlutterError(code: "UNSUPPORTED", message: "Not implemented yet", details: nil)))
  }
}

StorageApiSetup.setUp(binaryMessenger: controller.binaryMessenger, api: StorageApiImpl())
```

동기 메서드에서 던진 예외는 Dart의 `PlatformException`으로 변환된다. 비동기 메서드는 자동 처리가 없으므로 콜백으로 오류를 넘겨야 한다. 사용자 정의 `code`와 `details`를 전달하려면 Kotlin은 생성된 `FlutterError` 클래스를 쓰고, Swift는 `FlutterError`가 `Error`를 따르도록 확장해 둔다.

```swift
extension FlutterError: Error {}
```

Dart에서는 `StorageApi().getFreeBytes()`처럼 일반 메서드로 호출한다.

## 비교

| 항목 | MethodChannel | EventChannel | BasicMessageChannel | Pigeon |
|---|---|---|---|---|
| 형태 | 요청/응답 | 스트림 | 메시지/응답 | 요청/응답(생성 코드) |
| 방향 | 양방향 | 네이티브 → Dart | 양방향 | `@HostApi`, `@FlutterApi`로 양방향 |
| 타입 안전성 | 없음(문자열 키, 런타임 캐스팅) | 없음 | 코덱에 따름 | 생성 코드로 컴파일 시점 확인 |
| 사용자 정의 클래스 | `Map`으로 직접 변환 | `Map`으로 직접 변환 | 사용자 정의 코덱 필요 | 정의만 하면 직렬화 코드 생성 |
| 추가 의존성 | 없음 | 없음 | 없음 | `pigeon`(dev dependency), 빌드 단계 |
| 적합한 경우 | 메서드 몇 개짜리 간단한 연동 | 연속 이벤트 | 단일 형태 메시지 | 메서드가 많거나 데이터 구조가 복잡한 연동 |

## 정리

1. 플랫폼 채널은 이름과 코덱으로 식별되는 비동기 메시지 통로다. 이름에는 도메인 접두사를 붙이고 양쪽 코덱을 맞춘다.
2. 일회성 호출은 `MethodChannel`, 연속 값은 `EventChannel`, 단순 메시지는 `BasicMessageChannel`을 쓴다.
3. `StandardMessageCodec`의 `int`는 크기에 따라 Kotlin에서 `Int`/`Long`으로 갈리므로 `Number`로 받는다. Dart 쪽 반환 타입은 `invokeListMethod`, `invokeMapMethod`로 다룬다.
4. 네이티브 오류는 `result.error`/`FlutterError`로 보내 Dart에서 `PlatformException`으로 받고, 미구현은 `MissingPluginException`이 된다. `result`는 정확히 한 번 호출한다.
5. 핸들러는 기본적으로 메인 스레드에서 실행된다. 무거운 작업은 다른 스레드나 백그라운드 태스크 큐로 옮기고, 네이티브에서 Dart를 호출할 때는 메인 스레드로 돌아온다.
6. 메서드와 데이터 구조가 늘어나면 Pigeon으로 인터페이스를 정의하고 세 언어의 코드를 생성해 타입 불일치를 컴파일 시점에 잡는다.
