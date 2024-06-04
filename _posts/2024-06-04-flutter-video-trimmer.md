---
layout: post
title: Flutter 영상 트리밍 — 트리머 위젯 구조와 FFmpeg 처리
date: 2024-06-04
tags: [flutter]
description: 썸네일 스트립과 드래그 핸들, 구간 반복 미리보기로 트리머 UI를 구성하고, FFmpeg의 스트림 복사와 재인코딩, -ss 위치에 따른 정확도 차이를 정리한다.
---

숏폼 업로드 화면의 트리머는 두 부분으로 나뉜다. 사용자가 구간을 고르는 UI와, 고른 구간을 실제 파일로 잘라 내는 처리다. UI는 썸네일 스트립 위에서 시작·끝 핸들을 끌고, 미리보기 플레이어가 선택 구간만 반복 재생하는 구조다. 처리는 FFmpeg로 하는데, 같은 "자르기"라도 옵션에 따라 속도와 정확도가 크게 달라진다. 이 글은 두 부분을 차례로 다룬다.

## 트리머 UI의 구성

| 구성 요소 | 역할 | 사용 기술 |
|---|---|---|
| 미리보기 | 선택 구간 재생, 핸들 이동 시 해당 프레임 표시 | `video_player` |
| 썸네일 스트립 | 전체 영상의 시간축을 이미지로 표시 | `video_thumbnail` |
| 핸들 2개 | 시작·끝 위치 지정 | `GestureDetector` |
| 선택 영역 오버레이 | 구간 바깥을 어둡게 표시 | `CustomPaint` 또는 `Stack` |
| 재생 위치 표시줄 | 현재 재생 위치 | 미리보기 위치를 픽셀로 변환 |

핵심은 **시간과 픽셀의 변환**이다. 스트립 너비가 `w`픽셀, 영상 길이가 `d`일 때 픽셀당 시간은 `d / w`다. 모든 핸들 좌표와 재생 위치 표시가 이 비율로 계산된다.

## 상태 모델

```dart
class TrimRange {
  const TrimRange(this.start, this.end);
  final Duration start;
  final Duration end;
  Duration get length => end - start;
}

class TrimLimits {
  const TrimLimits({required this.min, required this.max});
  final Duration min;
  final Duration max;
}

TrimRange moveStart(TrimRange r, Duration to, TrimLimits limits) {
  var start = to < Duration.zero ? Duration.zero : to;
  if (r.end - start < limits.min) start = r.end - limits.min;
  if (r.end - start > limits.max) start = r.end - limits.max;
  return TrimRange(start, r.end);
}
```

시작 핸들을 움직이면 끝 핸들은 그대로 두고, 구간 길이가 최소·최대 길이를 벗어나지 않도록 시작 위치를 보정한다. 끝 핸들도 대칭으로 구현한다. 처음 화면에 들어왔을 때는 `TrimRange(Duration.zero, min(duration, limits.max))`로 시작하면 긴 영상도 바로 업로드 가능한 범위가 선택된다.

## 썸네일 스트립

스트립에 보일 썸네일 개수는 스트립 너비를 썸네일 한 장의 너비로 나눈 값이다. 각 썸네일은 해당 칸의 중앙 시점에서 추출한다.

```dart
Future<List<Uint8List?>> extractThumbnails({
  required String path,
  required Duration duration,
  required int count,
  required int height,
}) {
  final step = duration.inMilliseconds / count;
  return Future.wait([
    for (var i = 0; i < count; i++)
      VideoThumbnail.thumbnailData(
        video: path,
        imageFormat: ImageFormat.JPEG,
        maxHeight: height,
        timeMs: (step * i + step / 2).round(),
        quality: 60,
      ),
  ]);
}
```

`maxHeight`만 지정하고 `maxWidth`를 0으로 두면 원본 비율에 맞춰 너비가 정해진다. 스트립에 들어갈 크기로 줄여서 받아야 메모리를 아낄 수 있다. 화면에 표시할 때는 `Image.memory(bytes, gaplessPlayback: true, fit: BoxFit.cover)`를 쓰고, 썸네일이 준비되기 전에는 회색 칸을 보여 준다. 썸네일 추출은 기기마다 시간이 꽤 걸리므로, 스트립 전체를 한 번에 기다리기보다 준비된 칸부터 채우는 방식이 체감 속도가 좋다.

## 드래그 핸들

```dart
GestureDetector(
  behavior: HitTestBehavior.opaque,
  onHorizontalDragStart: (_) => controller.pause(),
  onHorizontalDragUpdate: (details) {
    final msPerPx = duration.inMilliseconds / stripWidth;
    final to = range.start + Duration(milliseconds: (details.delta.dx * msPerPx).round());
    setState(() => range = moveStart(range, to, limits));
    controller.seekTo(range.start);
  },
  onHorizontalDragEnd: (_) => controller.play(),
  child: const SizedBox(width: 48, height: 56, child: _HandleBar()),
)
```

핸들은 손가락으로 잡기 쉽도록 보이는 막대보다 넓은 터치 영역을 둔다. Android 접근성 가이드는 터치 대상 크기를 최소 48dp×48dp로 권장한다. 드래그 중에는 재생을 멈추고 `seekTo`로 해당 프레임을 보여 주면, 사용자가 자르는 지점을 눈으로 확인할 수 있다. `seekTo`를 매 업데이트마다 호출하면 디코더 부하가 커지므로, 필요하면 수십 ms 간격으로 묶어서 호출한다.

## 구간 반복 미리보기

`VideoPlayerController.setLooping(true)`는 영상 전체를 반복하므로 트리머에는 맞지 않는다. 재생 위치가 끝 지점을 넘으면 시작 지점으로 되돌리는 루프를 직접 만든다.

```dart
Timer? _loopTimer;

void startRangeLoop() {
  _loopTimer?.cancel();
  _loopTimer = Timer.periodic(const Duration(milliseconds: 50), (_) async {
    final pos = await controller.position;
    if (pos == null || !controller.value.isPlaying) return;
    if (pos >= range.end || pos < range.start) {
      await controller.seekTo(range.start);
    }
  });
}

@override
void dispose() {
  _loopTimer?.cancel();
  controller.dispose();
  super.dispose();
}
```

`controller.addListener`에서 `value.position`을 확인하는 방법도 있지만, `video_player` 2.8 구현은 재생 중 위치 값을 500ms 주기 타이머로 갱신한다. 리스너만으로 판정하면 끝 지점을 최대 0.5초가량 넘겨 재생할 수 있다. 위처럼 `position` 게터를 짧은 주기로 직접 호출하면 경계가 더 정확해진다. 재생 위치 표시줄은 같은 타이머에서 얻은 위치를 `(pos - start) / msPerPx`로 변환해 그린다.

## FFmpeg로 자르기: 스트림 복사와 재인코딩

구간이 정해지면 파일을 실제로 자른다. 방법은 두 가지다.

**스트림 복사(stream copy)** 는 `-c copy`로 지정하며, FFmpeg 문서의 설명대로 입력 스트림의 패킷을 디코딩·필터링·인코딩하지 않고 그대로 출력에 복사한다. 인코딩이 없으므로 매우 빠르고 화질 손실도 없다. 대신 필터를 적용할 수 없고, 자르는 지점의 정확도가 키프레임(keyframe)에 묶인다.

**재인코딩(re-encode)** 은 디코딩한 프레임을 다시 인코딩한다. 느리고 배터리를 쓰지만 원하는 프레임에서 정확하게 자를 수 있고, 해상도 축소나 비트레이트 조절로 파일 크기도 줄일 수 있다.

### 키프레임과 정확도

H.264 같은 코덱에서 대부분의 프레임은 앞 프레임과의 차이만 저장하고, 독립적으로 복원 가능한 프레임은 키프레임뿐이다. 키프레임 간격은 인코더 설정에 따라 다르며, 스마트폰 카메라 영상은 대체로 1초 안팎 이상인 경우가 많다(경험칙이며 기기마다 다르다). 스트림 복사로 키프레임이 아닌 지점에서 시작하면, 그 사이 프레임들은 참조할 키프레임이 없어 복원할 수 없다.

### -ss의 위치: 입력 탐색과 출력 탐색

FFmpeg 문서는 `-ss`의 동작을 위치에 따라 구분한다.

| 위치 | 동작 | 속도 |
|---|---|---|
| 입력 옵션(`-i` 앞) | 입력 파일에서 해당 위치로 탐색. 대부분의 포맷은 정확한 탐색이 불가능해 그 위치 직전의 탐색 지점으로 이동 | 빠름 |
| 출력 옵션(출력 파일 앞) | 입력을 디코딩하되 타임스탬프가 해당 위치에 도달할 때까지 버림 | 앞부분을 모두 디코딩하므로 느림 |

입력 옵션으로 쓸 때의 세부 동작이 중요하다. 재인코딩 중이고 `-accurate_seek`가 켜져 있으면(기본값) 탐색 지점과 요청 위치 사이 구간을 디코딩한 뒤 버리므로 결과가 정확하다. 반면 **스트림 복사이거나 `-noaccurate_seek`일 때는 그 구간이 보존된다.** 즉 `-ss`를 입력 옵션으로 쓰고 재인코딩하면 빠르면서도 정확하고, 스트림 복사하면 빠르지만 시작점이 요청보다 앞선 키프레임 쪽으로 당겨질 수 있다.

길이는 `-t`(지속 시간)로 지정한다. `-to`와 `-t`는 함께 쓸 수 없고 `-t`가 우선한다. 입력 탐색 후 `-to`의 기준 시점은 헷갈리기 쉬우므로, 트리머처럼 시작점과 길이를 이미 알고 있다면 `-t`가 명확하다.

```bash
ffmpeg -ss 12.400 -i input.mp4 -t 15.000 \
  -c:v libx264 -preset veryfast -crf 23 \
  -c:a aac -b:a 128k \
  -movflags +faststart output.mp4

ffmpeg -ss 12.400 -i input.mp4 -t 15.000 -c copy \
  -avoid_negative_ts make_zero output.mp4
```

- `-movflags +faststart`: MP4의 인덱스(moov 아톰)를 파일 앞으로 옮긴다. 업로드 후 스트리밍 재생 시 파일 끝까지 받지 않아도 재생을 시작할 수 있다. 두 번째 패스가 필요해 기본으로 꺼져 있다.
- `-avoid_negative_ts make_zero`: 첫 타임스탬프가 0이 되도록 모든 타임스탬프를 같은 양만큼 이동한다. 스트림 복사로 잘라 낸 파일의 시작 타임스탬프를 정리할 때 쓴다.
- `-fs`: 출력 파일 크기 상한(바이트)이다. 상한을 넘으면 더 쓰지 않으므로, 크기 제한을 넘은 파일이 잘린 채 만들어지는 것을 감수할 때만 쓴다.

## ffmpeg_kit_flutter로 실행하기

Flutter에서는 `ffmpeg_kit_flutter`(6.0.x)로 FFmpeg 명령을 실행한다. 패키지는 포함된 외부 라이브러리에 따라 `min`, `min-gpl`, `https`, `https-gpl`, `audio`, `video`, `full`, `full-gpl` 여덟 가지가 있고, 기본 `ffmpeg_kit_flutter`는 `https` 패키지다. 다른 패키지는 `ffmpeg_kit_flutter_min_gpl`처럼 하이픈을 밑줄로 바꾼 이름으로 의존성을 추가한다.

라이선스에 주의해야 한다. 기본 라이선스는 LGPL 3.0이지만, H.264 소프트웨어 인코더인 x264는 GPL 라이브러리라 `min-gpl`, `https-gpl`, `full-gpl` 패키지에만 들어 있다. `libx264`로 재인코딩하려면 GPL 패키지가 필요하고, 그 경우 앱 전체에 GPL 조건이 적용되는지 검토해야 한다. 스트림 복사만 쓴다면 LGPL 패키지로 충분하다. 최소 지원 버전은 기본(Main) 릴리스 기준 Android API 24, iOS 12.1이다.

경로에 공백이 있으면 문자열 명령의 파싱이 꼬이므로, 인자 목록을 받는 `executeWithArgumentsAsync`를 쓴다.

```dart
Future<String> trim({
  required String input,
  required String output,
  required TrimRange range,
  required bool reencode,
  void Function(double progress)? onProgress,
}) {
  final completer = Completer<String>();
  final args = <String>[
    '-y',
    '-ss', (range.start.inMilliseconds / 1000).toStringAsFixed(3),
    '-i', input,
    '-t', (range.length.inMilliseconds / 1000).toStringAsFixed(3),
    if (reencode) ...[
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
    ] else ...[
      '-c', 'copy', '-avoid_negative_ts', 'make_zero',
    ],
    '-movflags', '+faststart',
    output,
  ];

  FFmpegKit.executeWithArgumentsAsync(
    args,
    (session) async {
      final code = await session.getReturnCode();
      if (ReturnCode.isSuccess(code)) {
        completer.complete(output);
      } else if (ReturnCode.isCancel(code)) {
        completer.completeError(const TrimCancelled());
      } else {
        completer.completeError(TrimFailed(await session.getOutput()));
      }
    },
    null,
    (statistics) {
      final total = range.length.inMilliseconds;
      if (total > 0) onProgress?.call((statistics.getTime() / total).clamp(0.0, 1.0));
    },
  );
  return completer.future;
}
```

- 완료 콜백의 `session.getReturnCode()`를 `ReturnCode.isSuccess`, `ReturnCode.isCancel`로 판정한다. 실패 시 `getOutput()`의 로그를 함께 남겨야 원인을 찾을 수 있다.
- 통계 콜백의 `getTime()`은 지금까지 처리한 출력 시간(ms)이다. 구간 길이로 나누면 진행률이 된다.
- 사용자가 화면을 떠나면 `FFmpegKit.cancel(sessionId)`로 작업을 중단하고 임시 파일을 지운다.
- 출력 경로는 `path_provider`의 임시 디렉터리를 쓰고, 업로드가 끝나면 삭제한다.

## 길이와 크기 제한

숏폼 서비스는 최대 길이와 파일 크기를 정책으로 정한다. 값 자체는 서비스마다 다르므로 서버 설정에서 내려받아 `TrimLimits`에 넣고, 클라이언트와 서버 양쪽에서 검사한다.

| 검사 시점 | 항목 | 방법 |
|---|---|---|
| 영상 선택 직후 | 원본 길이, 해상도 | `VideoPlayerController.value.duration`, `size` |
| 구간 선택 중 | 최소·최대 길이 | `moveStart`/`moveEnd`에서 보정 |
| 처리 방식 결정 | 예상 크기 | 원본 비트레이트 × 구간 길이로 추정 |
| 처리 후 | 실제 파일 크기 | `File(output).length()` |
| 업로드 수신 | 길이, 크기, 코덱 | 서버에서 재검증 |

처리 방식은 이렇게 고를 수 있다. 원본이 이미 H.264/AAC이고 예상 크기가 상한 안이면 스트림 복사로 빠르게 자르고, 시작점이 수백 ms 앞당겨질 수 있다는 점을 감수한다. 예상 크기가 상한을 넘거나, 원본 코덱이 서비스에서 재생하기 어려운 형식이거나, 정확한 시작점이 중요하면 재인코딩한다. 재인코딩할 때는 `-vf scale=-2:1280`처럼 해상도를 낮추면 크기가 크게 줄어든다. `-2`는 비율을 유지하면서 짝수 크기로 맞추라는 뜻이다.

## 대안: 플랫폼 네이티브 API

FFmpeg 네이티브 라이브러리는 앱 크기를 눈에 띄게 늘리고 라이선스 검토도 필요하다. 트리밍과 단순 변환만 필요하다면 플랫폼 채널로 네이티브 API를 호출하는 방법도 있다. iOS는 `AVAssetExportSession`의 `timeRange`에 자를 구간을 `CMTimeRange`로 지정하고, `AVAssetExportPresetPassthrough` 프리셋을 쓰면 현재 포맷 그대로(재인코딩 없이), 다른 프리셋을 쓰면 재인코딩해 내보낸다. Android는 Jetpack Media3 Transformer에서 `MediaItem.ClippingConfiguration`의 `setStartPositionMs`·`setEndPositionMs`로 구간을 지정하며, 입력 형식이 출력 설정과 같으면 재인코딩 없이 샘플을 복사하는 트랜스먹싱(transmuxing)으로 자동 전환된다. 두 API 모두 기기의 하드웨어 인코더를 쓰므로 빠르고 앱 크기 부담이 없지만, 플랫폼마다 코드를 따로 작성하고 결과 차이를 맞춰야 한다.

## 비교

| 항목 | 스트림 복사(`-c copy`) | 재인코딩(libx264) | 네이티브 API |
|---|---|---|---|
| 속도 | 매우 빠름 | 느림(영상 길이·해상도에 비례) | 빠름(하드웨어 인코더) |
| 화질 | 손실 없음 | 재압축 손실 | 프리셋에 따라 다름 |
| 시작점 정확도 | 키프레임에 묶임 | 프레임 단위 | 패스스루는 제한, 재인코딩은 정확 |
| 크기 조절 | 불가(구간 비율만큼) | 해상도·CRF로 조절 | 프리셋·설정으로 조절 |
| 필터 적용 | 불가 | 가능 | 플랫폼 API 범위 내 |
| 라이선스 | LGPL 패키지로 가능 | GPL 패키지 필요 | 없음 |
| 앱 크기 영향 | FFmpeg 라이브러리 | FFmpeg + x264 | 없음 |
| 구현 비용 | 공통 Dart 코드 | 공통 Dart 코드 | 플랫폼별 코드 |

## 정리

1. 트리머 UI는 미리보기, 썸네일 스트립, 두 개의 핸들로 구성하며, 모든 좌표는 "영상 길이 ÷ 스트립 너비" 비율로 시간과 변환한다.
2. 썸네일은 칸 중앙 시점에서 스트립 높이에 맞게 줄여 추출하고, 준비된 칸부터 표시한다.
3. 구간 반복은 `setLooping` 대신 짧은 주기로 `position`을 확인해 끝 지점에서 시작점으로 `seekTo`한다. `video_player`의 `value.position`은 재생 중 500ms 주기로 갱신된다.
4. `-ss`를 입력 옵션으로 쓰면 빠르고, 재인코딩 시에는 `-accurate_seek` 기본값 덕분에 정확하다. 스트림 복사에서는 키프레임까지의 구간이 보존되어 시작점이 앞당겨질 수 있다.
5. 스트림 복사는 빠르고 무손실이지만 크기를 줄일 수 없고, 재인코딩은 느리지만 정확하며 크기를 조절할 수 있다. `libx264`는 GPL 패키지에만 있다.
6. 길이·크기 제한은 서버 정책 값으로 클라이언트와 서버 양쪽에서 검사하고, 트리밍만 필요하다면 `AVAssetExportSession`과 Media3 Transformer를 플랫폼 채널로 호출하는 방법도 검토한다.
