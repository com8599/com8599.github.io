---
layout: post
title: Flutter에서 네이티브 리소스 컨트롤러 다루기 — 오디오 컨트롤러 재생성과 dispose 순서
date: 2025-12-11
tags: [flutter]
description: 네이티브 플레이어·녹음기를 감싼 컨트롤러를 누가 만들고 언제 폐기할지 정하고, 소스 변경과 비동기 초기화 중의 폐기를 안전하게 처리하는 방법.
---

오디오 플레이어, 녹음기, 비디오 플레이어, 카메라처럼 플랫폼 자원을 쓰는 플러그인은 대부분 Dart 쪽에 **컨트롤러(controller)** 객체를 노출한다. 이 객체는 화면에 보이는 위젯 상태가 아니라 네이티브 쪽 디코더, 오디오 세션, 파일 핸들을 가리키는 핸들이다. 그래서 일반 상태 객체보다 수명 관리가 까다롭다. 이미 폐기한 컨트롤러를 다시 쓰거나, 초기화가 끝나기 전에 화면이 닫히거나, 재생할 파일이 바뀌었는데 컨트롤러를 재사용하면 디버그 단언(assertion) 오류, 재생되지 않는 플레이어, 해제되지 않는 네이티브 자원이 생긴다.

`State`의 생명주기 메서드 자체와 `didUpdateWidget`에서 컨트롤러를 교체하는 기본형은 [Flutter 위젯 생명주기 글](/2024/02/27/flutter-widget-lifecycle/)에서 다뤘다. 이 글은 그 위에서 소유권, 비동기 초기화 경합, 자식 위젯과의 교체 순서를 다룬다. 예제는 Flutter 3.38(Dart 3.10), `audio_waveforms` 2.0.1, `flutter_riverpod` 2.6.1 기준이다.

## 컨트롤러는 네이티브 자원의 핸들이다

`audio_waveforms`의 `PlayerController`와 `RecorderController`, `video_player`의 `VideoPlayerController`는 모두 `ChangeNotifier` 계열이다. Dart 객체 하나가 네이티브 플레이어 하나와 짝을 이룬다. `PlayerController`는 생성할 때 고유한 `playerKey`를 만들고, 플랫폼에서 오는 상태·진행 이벤트를 이 키로 걸러서 자기 것만 받는다.

`ChangeNotifier.dispose`의 API 문서는 두 가지를 분명히 한다.

- 호출 후 객체는 사용할 수 없는 상태이며 버려야 한다. 폐기 후 `addListener`를 부르면 예외가 난다.
- 이 메서드는 **객체의 소유자만** 호출해야 한다.

디버그 모드에서는 폐기된 객체에 `addListener`, `notifyListeners`, `dispose`를 호출하면 `A PlayerController was used after being disposed.` 같은 `FlutterError`가 발생한다. 즉 두 번 폐기하는 것도 오류다. 반면 `removeListener`는 폐기 후 호출을 허용한다. 소유자가 리스너보다 한 프레임 먼저 폐기되는 경우가 흔하기 때문이라고 소스 주석에 적혀 있다.

플러그인마다 폐기 후 동작은 다르다. `video_player` 문서는 `dispose` 이후의 호출은 무시된다고 명시하지만, 모든 플러그인이 그렇지는 않다. 폐기된 컨트롤러가 조용히 무시해 줄 것이라고 기대하지 않는 편이 안전하다.

## 폐기 관련 오류의 유형

| 상황 | 증상 | 원인 |
|---|---|---|
| 폐기된 컨트롤러 재사용 | `was used after being disposed` 단언, 재생 무반응 | `late final` 필드를 다시 쓰거나 같은 인스턴스로 `prepare`를 재시도 |
| 이중 폐기 | 디버그 단언 | 부모와 자식이 같은 컨트롤러를 각각 `dispose` |
| 초기화 중 화면 종료 | `setState() called after dispose()`, 네이티브 자원 누수 | `await` 뒤에 `mounted`·세대 검사 없음 |
| 소스 변경 후 늦게 끝난 초기화 | 이전 파일이 재생됨 | 먼저 시작한 `prepare`가 나중에 끝나 최신 컨트롤러를 덮어씀 |
| 자식 위젯이 이전 컨트롤러를 계속 구독 | 파형·진행 표시가 갱신되지 않음 | 자식이 `initState`에서만 구독하고 `didUpdateWidget`에서 교체하지 않음 |

`PlayerController.dispose`는 `void dispose() async`로 구현되어 있어, 내부에서 `stopPlayer()`와 `release()`를 기다린 뒤에 `super.dispose()`를 호출한다. 반환 타입이 `void`라서 호출한 쪽은 네이티브 해제가 끝날 때까지 기다릴 수 없다. 따라서 "이전 컨트롤러를 폐기했으니 같은 파일로 바로 다시 준비해도 된다"고 가정하지 말고, **매번 새 인스턴스**를 만들어야 한다.

## 소유권 규칙: 만든 쪽이 폐기한다

규칙은 하나다. **컨트롤러를 생성한 객체가 폐기한다.** 생성자 인자로 컨트롤러를 받은 위젯은 그것을 쓰기만 하고 `dispose`하지 않는다.

```dart
class WaveformView extends StatelessWidget {
  const WaveformView({super.key, required this.controller});

  final PlayerController controller;

  @override
  Widget build(BuildContext context) {
    return AudioFileWaveforms(
      size: Size(MediaQuery.sizeOf(context).width, 96),
      playerController: controller,
      waveformType: WaveformType.fitWidth,
    );
  }
}
```

`WaveformView`는 컨트롤러를 받기만 하므로 `StatelessWidget`으로 충분하다. 폐기 책임은 컨트롤러를 만든 상위 `State`나 Provider에 있다.

## 소스가 바뀌면 새로 만든다

재생할 파일 경로가 바뀌면 기존 컨트롤러를 재사용하지 않고 새로 만든다. 이때 필드를 `late final`이 아닌 nullable로 두고, 비동기 준비가 끝난 뒤에만 필드에 대입한다. 준비 도중 경로가 또 바뀌거나 화면이 닫힐 수 있으므로 **세대 토큰(generation token)** 을 쓴다. 준비를 시작할 때 정수를 하나 올리고, `await` 뒤에 그 값이 아직 최신인지 확인한다.

```dart
class AnswerPlayer extends StatefulWidget {
  const AnswerPlayer({super.key, required this.path});

  final String path;

  @override
  State<AnswerPlayer> createState() => _AnswerPlayerState();
}

class _AnswerPlayerState extends State<AnswerPlayer> {
  PlayerController? _controller;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load(widget.path);
  }

  @override
  void didUpdateWidget(covariant AnswerPlayer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.path != widget.path) _load(widget.path);
  }

  Future<void> _load(String path) async {
    final generation = ++_generation;
    final previous = _controller;
    final next = PlayerController();

    _controller = null;
    _disposeAfterFrame(previous);

    try {
      await next.preparePlayer(path: path, shouldExtractWaveform: true);
    } catch (_) {
      next.dispose();
      return;
    }

    if (!mounted || generation != _generation) {
      next.dispose();
      return;
    }
    setState(() => _controller = next);
  }

  void _disposeAfterFrame(PlayerController? controller) {
    if (controller == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) => controller.dispose());
  }

  @override
  void dispose() {
    _generation++;
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (controller == null) {
      return const SizedBox(height: 96, child: Center(child: CircularProgressIndicator()));
    }
    return WaveformView(key: ObjectKey(controller), controller: controller);
  }
}
```

핵심은 다음과 같다.

- `_load`는 `initState`와 `didUpdateWidget`에서만 호출되고, 두 메서드 뒤에는 프레임워크가 항상 `build`를 호출하므로 `_controller = null`에 `setState`가 필요 없다.
- 새 컨트롤러는 지역 변수 `next`로 준비하고, 검사를 통과한 뒤에만 `_controller`에 넣는다. 준비 중인 컨트롤러는 아직 아무 위젯도 구독하지 않으므로 탈락할 때 바로 폐기해도 된다.
- `generation != _generation`은 "내가 시작한 뒤에 다른 준비가 시작됐는가"를 묻는다. 경로를 `widget.path`끼리 비교하면 항상 같은 값을 비교하게 되어 검사가 무의미해진다. 시작 시점의 값을 지역 변수에 잡아 두는 것이 요점이다.
- `dispose`에서 `_generation`을 올리면 진행 중인 준비가 끝났을 때 결과가 폐기된다. `mounted` 검사와 같은 효과지만, 경로 변경과 화면 종료를 한 조건으로 처리한다.
- `catch`에서도 새 컨트롤러를 폐기한다. 준비 실패한 컨트롤러를 필드에 남기면 다음 재시도에서 재사용하게 된다.

## 자식 위젯과의 교체 순서

`AudioFileWaveforms`는 `initState`에서 컨트롤러의 진행 스트림과 리스너를 구독하고 `dispose`에서 해제한다. `didUpdateWidget`에서 컨트롤러 교체를 처리하지 않으므로, 같은 위치에 새 컨트롤러를 넘겨도 `State`는 이전 컨트롤러를 계속 본다. 위 코드의 `ObjectKey(controller)`는 컨트롤러가 바뀔 때 엘리먼트를 새로 만들게 해서 구독도 새로 맺게 한다.

이전 컨트롤러는 화면에서 내려간 다음에 폐기한다. `_controller`를 `null`로 바꾸고 다시 빌드하면 그 프레임에서 이전 자식 위젯이 언마운트되며 구독을 해제한다. `addPostFrameCallback`으로 그 프레임이 끝난 뒤 `dispose`하면, 이전 자식이 폐기된 컨트롤러에 접근할 틈이 없다.

반대로 화면 전체가 닫힐 때는 순서 걱정이 적다. 프레임워크는 비활성 엘리먼트를 언마운트할 때 자식부터 재귀적으로 처리하므로, 자식 `State.dispose`가 부모 `State.dispose`보다 먼저 호출된다.

## 녹음 컨트롤러

`RecorderController`도 같은 규칙을 따른다. `record({String? path, RecorderSettings recorderSettings})`로 녹음을 시작하고, `stop()`은 `Future<String?>`을 반환한다. 2.0.0에서 중복 파라미터가 정리되고 녹음 설정이 `RecorderSettings` 모델로 모였다.

```dart
Future<String?> finishRecording(RecorderController recorder) async {
  if (recorder.recorderState != RecorderState.recording) return null;
  final path = await recorder.stop();
  return path;
}
```

`RecorderController.dispose` 역시 녹음 중이면 내부에서 `stop()`을 기다린 뒤 스트림과 타이머를 닫는다. 녹음 파일 경로가 필요하다면 화면을 닫기 전에 직접 `stop()`을 호출해 값을 받아 둬야 한다. `dispose`에 맡기면 결과 경로를 받을 수 없다.

## Riverpod로 소유권 옮기기

컨트롤러를 여러 위젯이 공유하거나, 화면 이동 후에도 잠시 유지해야 한다면 소유자를 Provider로 옮긴다. Riverpod 2.x에서 `autoDispose` Provider는 더 이상 구독되지 않으면 상태를 폐기하고, `ref.onDispose`는 폐기 직전에 실행할 콜백을 등록한다. Provider가 다시 계산될 때도 이전 상태는 폐기된다.

```dart
final preparedPlayerProvider =
    FutureProvider.autoDispose.family<PlayerController, String>((ref, path) async {
  final controller = PlayerController();
  ref.onDispose(controller.dispose);

  await controller.preparePlayer(path: path, shouldExtractWaveform: true);
  return controller;
});
```

`ref.onDispose`를 `await`보다 **먼저** 등록하는 것이 중요하다. 준비 도중 화면이 닫혀 Provider가 폐기되어도 컨트롤러가 정리된다. 경로가 바뀌면 `family` 인자가 달라지므로 별개의 Provider 인스턴스가 만들어지고, 이전 경로의 인스턴스는 구독이 끊기면서 폐기된다. 세대 토큰을 직접 관리할 필요가 없다.

```dart
class AnswerPlayerView extends ConsumerWidget {
  const AnswerPlayerView({super.key, required this.path});

  final String path;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final player = ref.watch(preparedPlayerProvider(path));
    return player.when(
      data: (controller) => WaveformView(key: ObjectKey(controller), controller: controller),
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => const Text('재생할 수 없습니다'),
    );
  }
}
```

이 구조에서 위젯은 컨트롤러를 만들지도, 폐기하지도 않는다. 같은 경로를 쓰는 두 위젯은 같은 컨트롤러를 공유하며, 둘 다 사라져야 폐기된다. 다만 `ref.read`로만 읽으면 구독이 생기지 않아 `autoDispose` Provider가 곧바로 폐기될 수 있으므로, 화면에서는 `ref.watch`로 구독을 유지한다.

## 소유권 배치 비교

| 소유 위치 | 생성 시점 | 폐기 시점 | 장점 | 주의점 |
|---|---|---|---|---|
| `State` 필드(`late final`) | `initState` | `State.dispose` | 가장 단순 | 소스 변경 시 재생성 불가, 재사용 오류 위험 |
| `State` 필드(nullable + 세대 토큰) | 소스가 바뀔 때마다 | 교체 직후 프레임 종료 시, `State.dispose` | 소스 변경과 비동기 경합 처리 | 코드가 길어짐, 자식에 키 필요 |
| 부모 위젯이 생성해 자식에 전달 | 부모의 `initState` | 부모의 `dispose` | 여러 자식이 공유 | 자식이 폐기하면 이중 폐기 |
| `Provider.autoDispose` + `ref.onDispose` | 첫 구독 | 마지막 구독 해제, 재계산 | 위젯 수명과 분리, 공유 쉬움 | `read`만 하면 즉시 폐기될 수 있음 |
| `autoDispose.family` (소스별) | 인자별 첫 구독 | 인자별 마지막 구독 해제 | 소스 변경을 인자로 표현, 경합 처리 불필요 | 인자가 많으면 인스턴스가 많아짐 |
| 전역 싱글턴 | 앱 시작 | 없음 | 생성 비용 1회 | 네이티브 자원을 계속 점유, 상태 오염 |

## 정리

1. 플레이어·녹음기 컨트롤러는 네이티브 자원의 핸들이다. `ChangeNotifier` 문서대로 폐기 후에는 버려야 하며, 폐기는 소유자만 한다.
2. 폐기된 컨트롤러는 재사용하지 않는다. 소스가 바뀌면 새 인스턴스를 만든다. `PlayerController.dispose`는 내부적으로 비동기 해제를 하지만 호출자가 기다릴 수 없다.
3. 컨트롤러 필드는 nullable로 두고, 준비가 끝난 뒤에만 대입한다. `await` 뒤에는 세대 토큰과 `mounted`로 결과가 아직 유효한지 확인하고, 탈락한 컨트롤러는 즉시 폐기한다.
4. 컨트롤러를 `initState`에서만 구독하는 자식 위젯에는 `ObjectKey(controller)`를 줘서 교체 시 다시 구독하게 하고, 이전 컨트롤러는 화면에서 내려간 프레임 이후에 폐기한다.
5. 녹음 결과 경로가 필요하면 `dispose`에 맡기지 말고 `stop()`을 직접 호출한다.
6. 공유가 필요하면 Riverpod `autoDispose`(소스별이면 `family`) Provider로 소유권을 옮기고, `ref.onDispose`는 첫 `await`보다 먼저 등록한다.
