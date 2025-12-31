---
layout: post
title: Flutter 글자 크기 확대 대응 — TextScaler와 깨지지 않는 레이아웃
date: 2025-12-31
tags: [flutter]
description: 시스템 글자 크기가 TextScaler로 전달되는 구조, 앱 안 글자 크기 설정을 시스템 설정과 합치는 방법, 배율 제한의 접근성 비용, 큰 글자에서 깨지지 않는 레이아웃과 테스트 방법을 정리한다.
---

Android와 iOS 모두 사용자가 시스템 설정에서 글자 크기를 바꿀 수 있고, Flutter의 텍스트 위젯은 이 설정을 따라 커진다. 공식 접근성 문서도 글자 크기 계산은 Flutter가 자동으로 하니 개발자는 늘어난 글자를 담을 공간을 레이아웃에 확보하라고 안내한다. 고정 높이 버튼과 한 줄 전제 `Row`가 많은 화면은 큰 글자에서 바로 오버플로(Overflow)가 난다. 이 글은 Flutter 3.38 기준으로 글자 배율이 전달되는 구조와 대응 방법을 정리한다.

## textScaleFactor에서 TextScaler로

예전에는 배율이 `double` 하나(`textScaleFactor`)였다. 글자 크기는 `fontSize × textScaleFactor`로 비례 계산되었다. Android 14는 글꼴 크기를 200%까지 키울 수 있게 하면서 비선형(Nonlinear) 배율 곡선을 도입했다. 큰 글자는 작은 글자보다 덜 커지게 해서 제목이 화면을 넘치지 않게 하는 방식이다. 이런 배율은 숫자 하나로 표현할 수 없다.

그래서 Flutter는 `textScaleFactor`를 사용 중단(Deprecated)하고 `TextScaler`로 바꿨다. 이 변경은 3.16 안정 버전에 포함되었다.

```dart
abstract class TextScaler {
  double scale(double fontSize);
  double get textScaleFactor; // deprecated
}
```

| 이전 API | 대체 API |
|---|---|
| `MediaQuery.textScaleFactorOf(context)` | `MediaQuery.textScalerOf(context)` |
| `MediaQueryData.copyWith(textScaleFactor:)` | `copyWith(textScaler:)` |
| `Text(textScaleFactor:)` | `Text(textScaler:)` |
| `fontSize * factor` | `textScaler.scale(fontSize)` |

기기 설정에서 오는 기본 `TextScaler`는 `SystemTextScaler`이고, `scale()`은 플랫폼의 `scaleFontSize`를 호출한다. 따라서 같은 설정에서도 14pt와 32pt의 확대 비율이 다를 수 있다. 직접 배율이 필요할 때는 `TextScaler.linear(1.2)`, 확대를 막을 때는 `TextScaler.noScaling`을 쓴다.

## 앱 안 글자 크기 설정과 시스템 설정 합치기

시니어 사용자나 학습용 앱은 시스템 설정과 별개로 앱 안에서 "작게/보통/크게"를 고르게 하는 경우가 많다. `MaterialApp.builder`에서 `MediaQuery`를 덮어쓰면 앱 전체에 적용된다.

흔한 실수는 시스템 배율을 버리고 `TextScaler.linear(userScale)`로 교체하는 것이다. 이러면 시스템에서 글자를 키운 사용자가 앱에서는 기본 크기를 보게 된다. 시스템 배율 위에 앱 배율을 곱하는 `TextScaler`를 만든다.

```dart
class AppTextScaler extends TextScaler {
  const AppTextScaler(this.base, this.factor);

  final TextScaler base;
  final double factor;

  @override
  double scale(double fontSize) => base.scale(fontSize) * factor;

  @override
  double get textScaleFactor => scale(14) / 14; // 하위 호환용 근사값

  @override
  bool operator ==(Object other) =>
      other is AppTextScaler && other.base == base && other.factor == factor;

  @override
  int get hashCode => Object.hash(base, factor);
}
```

`==`와 `hashCode`를 구현하지 않으면 `MediaQuery`가 바뀐 것으로 판단해 의존하는 위젯이 매번 다시 빌드된다. API 문서도 `TextScaler` 구현 시 `==`를 재정의하라고 권한다.

배율 값은 Riverpod의 `Notifier`로 관리한다. 상태 관리 도구 자체의 비교는 [Flutter 상태 관리 비교](/2024/04/02/flutter-state-management/)에서 다뤘다.

```dart
enum FontSizeOption { small, normal, large, xlarge }

extension on FontSizeOption {
  double get factor => switch (this) {
        FontSizeOption.small => 0.9,
        FontSizeOption.normal => 1.0,
        FontSizeOption.large => 1.15,
        FontSizeOption.xlarge => 1.3,
      };
}

class FontSizeNotifier extends Notifier<FontSizeOption> {
  @override
  FontSizeOption build() => FontSizeOption.normal;

  void select(FontSizeOption option) => state = option;
}

final fontSizeProvider =
    NotifierProvider<FontSizeNotifier, FontSizeOption>(FontSizeNotifier.new);

class App extends ConsumerWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final option = ref.watch(fontSizeProvider);

    return MaterialApp.router(
      routerConfig: router,
      builder: (context, child) {
        final media = MediaQuery.of(context);
        return MediaQuery(
          data: media.copyWith(
            textScaler: AppTextScaler(media.textScaler, option.factor),
          ),
          child: child!,
        );
      },
    );
  }
}
```

선택 값은 `shared_preferences` 같은 저장소에 보관하고 `build()`에서 복원한다. 연속 슬라이더보다 몇 단계의 선택지가 테스트하기 쉽다. 단계마다 화면을 확인하면 되기 때문이다.

## 배율 제한과 접근성 비용

`TextScaler.clamp`와 `MediaQuery.withClampedTextScaling`은 확대 결과를 `[min × fontSize, max × fontSize]` 범위로 자른다.

```dart
MediaQuery.withClampedTextScaling(
  maxScaleFactor: 1.5,
  child: const ScoreBoard(),
)
```

배율 제한은 레이아웃을 지키는 가장 쉬운 방법이지만 그만큼 사용자가 요청한 크기를 무시한다. WCAG 2.2 성공 기준 1.4.4 텍스트 크기 조정(Resize Text, AA)은 캡션과 텍스트 이미지를 제외한 텍스트를 보조 기술 없이 200%까지 키워도 콘텐츠나 기능이 손실되지 않아야 한다고 요구한다. WCAG는 웹 콘텐츠 기준이지만, W3C는 이를 모바일 앱 같은 비웹 소프트웨어에 적용하는 방법을 WCAG2ICT 문서로 따로 안내한다.

실무 원칙은 다음과 같다.

- 앱 전체에 상한을 걸지 않는다. 깨지는 위젯만 찾아 레이아웃을 고친다.
- 상한은 공간이 물리적으로 정해진 요소(탭 바 라벨, 점수 배지)에만 국소적으로 건다.
- 상한을 걸더라도 최소 2.0 근처로 두는 것을 우선 검토한다.
- 아이콘 폰트처럼 글자가 아닌 것은 `MediaQuery.withNoTextScaling`으로 제외한다. 반대로 글자 옆 아이콘이 함께 커져야 하면 `Icon.applyTextScaling`을 쓴다.

## 깨지지 않는 레이아웃 기법

### 고정 높이 대신 최소 높이

```dart
ConstrainedBox(
  constraints: const BoxConstraints(minHeight: 48),
  child: Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    child: Text(label, textAlign: TextAlign.center),
  ),
)
```

`SizedBox(height: 48)` 안의 텍스트는 두 줄이 되는 순간 잘리거나 오버플로가 난다. 최소 높이만 주면 탭 영역 기준(Android 48×48dp, iOS 44×44pt)을 지키면서 늘어날 수 있다.

### Row 안의 텍스트는 Flexible로

`Row`는 자식에게 가로 방향으로 제한 없는 제약을 주므로, 긴 `Text`는 줄바꿈하지 않고 넘친다. `Expanded`나 `Flexible`로 감싸야 남은 폭이 전달되어 줄바꿈된다.

```dart
Row(
  children: [
    const Icon(Icons.timer_outlined),
    const SizedBox(width: 8),
    Expanded(child: Text(remainingLabel)),
    Text('$score', style: Theme.of(context).textTheme.titleMedium),
  ],
)
```

### 가로 나열은 Wrap으로

칩이나 단어 버튼처럼 개수가 바뀌는 가로 나열은 `Wrap`을 쓴다. 글자가 커져 폭이 모자라면 다음 줄로 내려간다.

### 배율에 따라 배치 바꾸기

남은 폭이나 실제 배율을 보고 가로 배치를 세로로 바꾼다.

```dart
Widget build(BuildContext context) {
  final scaled = MediaQuery.textScalerOf(context).scale(16) / 16;

  return LayoutBuilder(
    builder: (context, constraints) {
      final stacked = scaled > 1.4 || constraints.maxWidth < 360;
      final buttons = [
        FilledButton(onPressed: onRetry, child: Text(retryLabel)),
        OutlinedButton(onPressed: onNext, child: Text(nextLabel)),
      ];
      return stacked
          ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: buttons)
          : Row(children: [for (final b in buttons) Expanded(child: b)]);
    },
  );
}
```

비선형 배율에서는 글자 크기마다 비율이 다르므로, 판단 기준이 되는 기준 크기(위 예에서는 16)를 실제로 쓰는 본문 크기로 잡는다. 1.4, 360 같은 임계값은 화면마다 확인해서 정하는 경험칙이다.

### FittedBox의 함정

`FittedBox(fit: BoxFit.scaleDown)`은 넘치는 텍스트를 줄여서 맞춘다. 레이아웃은 깨지지 않지만 사용자가 키운 글자를 다시 줄이는 것이므로 배율 제한과 같은 비용이 있다. 숫자 하나, 짧은 배지처럼 공간이 고정된 곳에만 쓰고 본문에는 쓰지 않는다.

### 스크롤 가능한 화면

세로 공간도 부족해진다. 고정 화면이라고 생각한 설정 화면이나 결과 화면도 `SingleChildScrollView`나 `ListView`로 감싸 두면 큰 글자에서 아래쪽 버튼이 화면 밖으로 사라지지 않는다.

## 큰 배율로 테스트하기

위젯 테스트에서는 `tester.platformDispatcher`(`TestPlatformDispatcher`)의 `textScaleFactorTestValue`로 시스템 배율을 흉내 낸다. 레이아웃 오버플로는 테스트 실패로 이어지므로 배율별로 같은 화면을 그려 보는 것만으로 회귀를 잡을 수 있다.

```dart
void main() {
  for (final scale in [1.0, 1.5, 2.0]) {
    testWidgets('결과 화면이 배율 $scale에서 넘치지 않는다', (tester) async {
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(const ProviderScope(child: App()));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
    });
  }
}
```

특정 위젯만 확인할 때는 `MediaQuery(data: MediaQueryData(textScaler: TextScaler.linear(2.0)), child: ...)`로 감싸서 그린다. 탭 영역은 `meetsGuideline(androidTapTargetGuideline)`과 `iOSTapTargetGuideline`으로 함께 점검할 수 있다. 실기기에서는 Android의 접근성 설정에서 글꼴 크기를 최대로, iOS에서는 더 큰 텍스트(Larger Text)를 켜고 작은 화면 기기로 확인한다.

## 대응 방법 비교

| 방법 | 레이아웃 안정성 | 사용자 요청 존중 | 적합한 곳 |
|---|---|---|---|
| 앱 전체 배율 제한 | 높음 | 낮음 | 권장하지 않음 |
| 위젯 단위 `withClampedTextScaling` | 높음 | 중간 | 탭 바, 배지, 공간이 고정된 요소 |
| `FittedBox(scaleDown)` | 높음 | 낮음 | 짧은 숫자, 한 단어 라벨 |
| `Flexible`/`Expanded` + 줄바꿈 | 중간 | 높음 | `Row` 안의 문장 |
| `Wrap` | 중간 | 높음 | 칩, 단어 버튼 나열 |
| 최소 높이(`minHeight`) | 중간 | 높음 | 버튼, 리스트 항목 |
| `LayoutBuilder`로 배치 전환 | 높음 | 높음 | 버튼 그룹, 카드 내부 |
| 스크롤 감싸기 | 높음 | 높음 | 세로 공간이 부족한 화면 |

## 정리

1. 글자 배율은 `textScaleFactor`가 아니라 `TextScaler`로 다루며, 이 전환은 Android 14의 비선형 배율 때문에 3.16에서 이루어졌다.
2. 시스템 배율은 `SystemTextScaler`로 전달되고 글자 크기마다 비율이 다를 수 있다.
3. 앱 안 글자 크기 설정은 시스템 배율을 대체하지 말고 곱해서 적용하며, 커스텀 `TextScaler`에는 `==`와 `hashCode`를 구현한다.
4. 배율 제한은 WCAG 1.4.4(200%)와 충돌할 수 있으므로 국소적으로만 쓴다.
5. 고정 높이 대신 최소 높이, `Row` 안 텍스트는 `Flexible`, 가로 나열은 `Wrap`, 좁을 때는 배치 전환을 쓴다.
6. `textScaleFactorTestValue`로 여러 배율에서 위젯 테스트를 돌려 오버플로를 회귀 테스트로 잡는다.
