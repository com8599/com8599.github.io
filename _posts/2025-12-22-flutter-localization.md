---
layout: post
title: Flutter 다국어 지원 — easy_localization, 복수형, iOS 언어 등록
date: 2025-12-22
tags: [flutter]
description: 공식 gen-l10n(ARB)과 easy_localization(JSON)의 구조와 복수형 처리, 로케일 결정 순서, iOS 언어 등록, intl 숫자·날짜 서식, 번역 길이 차이에 대응하는 레이아웃을 정리한다.
---

Flutter 앱을 여러 언어로 내려면 세 가지를 정해야 한다. 번역 문자열을 어디에 어떤 형식으로 둘지, 앱이 어떤 로케일(Locale)을 쓸지 어떻게 결정할지, 그리고 숫자·날짜·복수형처럼 언어마다 규칙이 다른 부분을 어떻게 처리할지다. 공식 방식인 `flutter_localizations` + gen-l10n과 서드파티 패키지인 easy_localization은 이 세 가지에 서로 다른 답을 낸다. 이 글은 Flutter 3.38, easy_localization 3.0.8, intl 0.20 기준이다.

## 두 계층: 위젯 로컬라이제이션과 앱 문자열

다국어 지원은 두 계층으로 나뉜다.

| 계층 | 담당 | 예 |
|---|---|---|
| 프레임워크 문자열 | `flutter_localizations`의 `GlobalMaterialLocalizations` 등 | 날짜 선택기의 월 이름, "복사/붙여넣기" 메뉴, 텍스트 방향 |
| 앱 문자열 | gen-l10n 또는 easy_localization | 버튼 라벨, 안내 문구, 오류 메시지 |

앱 문자열을 어떤 방식으로 관리하든 프레임워크 문자열은 `flutter_localizations`의 델리게이트(Delegate)가 제공한다. easy_localization도 `context.localizationDelegates`를 반환할 때 자체 델리게이트와 함께 `GlobalMaterialLocalizations.delegate`, `GlobalWidgetsLocalizations.delegate`, `GlobalCupertinoLocalizations.delegate`를 묶어서 넘긴다.

## 공식 방식: gen-l10n과 ARB

공식 문서의 구성은 `pubspec.yaml`에 `flutter_localizations`(SDK)와 `intl`을 추가하고, `flutter` 섹션에 `generate: true`를 켜는 것이다. 번역은 ARB(Application Resource Bundle) 파일에 두고, 빌드 시 `AppLocalizations` 클래스가 생성된다.

```yaml
# l10n.yaml
arb-dir: lib/l10n
template-arb-file: app_en.arb
output-localization-file: app_localizations.dart
```

예전에는 생성 코드를 `package:flutter_gen/gen_l10n/...` 합성 패키지(Synthetic Package)에서 import했다. 이 방식은 Flutter 3.32 무렵부터 폐기 절차에 들어갔고, 현재는 생성 파일이 소스 디렉터리(기본값은 `arb-dir`)에 만들어지며 `import 'l10n/app_localizations.dart';`처럼 상대 경로로 가져온다.

ARB 메시지는 ICU 메시지 형식(ICU Message Format)을 따른다. 복수형은 `plural`, 분기는 `select`를 쓴다.

```json
{
  "itemCount": "{count, plural, =0{No items} =1{One item} other{Total: {count} items}}",
  "@itemCount": {
    "placeholders": {
      "count": { "type": "int" }
    }
  },
  "pronoun": "{gender, select, male{he} female{she} other{they}}"
}
```

`plural`은 `=0`, `=1`, `=2` 같은 정확한 값과 `zero`·`one`·`two`·`few`·`many`·`other` 범주를 받으며 `other`만 필수다. `select`는 대소문자를 구분해서 `"Male"`을 넘기면 `other`로 떨어진다. 한국어·일본어는 CLDR 복수 규칙상 `other` 범주만 있으므로, 0개일 때 문구를 바꾸려면 범주가 아니라 `=0`으로 지정해야 한다.

숫자·날짜 플레이스홀더에는 `format`을 지정할 수 있다. 숫자는 `compact`, `decimalPattern`, `currency`, `percentPattern` 등 `NumberFormat` 생성자 이름을, 날짜는 `yMd`처럼 `DateFormat` 생성자 이름을 쓴다. 같은 `yMd`가 영어에서는 `7/9/1959`, 러시아어에서는 `9.07.1959`가 된다.

## easy_localization: JSON 파일과 런타임 로딩

easy_localization은 번역을 에셋 폴더의 파일로 두고 런타임에 읽는다. 파일 이름은 `언어코드.json` 또는 `언어코드-국가코드.json`이다. JSON 외에 CSV, YAML, XML은 별도 패키지인 easy_localization_loader가 필요하다.

```json
{
  "app_title": "Speech Practice",
  "greeting": "Hello, {name}",
  "lesson": {
    "start": "Start lesson",
    "done": "Lesson complete"
  },
  "remaining": {
    "zero": "No questions left",
    "one": "{} question left",
    "other": "{} questions left"
  }
}
```

```json
{
  "app_title": "말하기 연습",
  "greeting": "{name}님, 안녕하세요",
  "lesson": {
    "start": "학습 시작",
    "done": "학습 완료"
  },
  "remaining": {
    "zero": "남은 문제가 없습니다",
    "other": "{}문제 남음"
  }
}
```

중첩 객체는 점으로 이어 `'lesson.start'.tr()`처럼 부른다. 위치 인자는 `{}`와 `args`, 이름 인자는 `{name}`과 `namedArgs`로 채운다.

```dart
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await EasyLocalization.ensureInitialized();

  runApp(
    EasyLocalization(
      supportedLocales: const [
        Locale('en', 'US'),
        Locale('ko', 'KR'),
        Locale('ja', 'JP'),
      ],
      path: 'assets/translations',
      fallbackLocale: const Locale('en', 'US'),
      useFallbackTranslations: true,
      child: const App(),
    ),
  );
}

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      localizationsDelegates: context.localizationDelegates,
      supportedLocales: context.supportedLocales,
      locale: context.locale,
      home: const HomePage(),
    );
  }
}
```

```dart
Text('greeting'.tr(namedArgs: {'name': userName}));
Text('remaining'.plural(left));
await context.setLocale(const Locale('ja', 'JP'));
```

`plural()`의 동작은 `ignorePluralRules` 값에 따라 달라진다. 기본값 `true`에서는 0이면 `zero`, 1이면 `one`, 2이면 `two`, 나머지는 `other`를 고르고, 해당 하위 키가 없으면 `other`로 내려간다. 위 한국어 파일에 `one`이 없어도 1이 "1문제 남음"으로 나오는 이유다. `false`로 바꾸면 언어별 CLDR 규칙을 따르므로 영어에서 0은 `zero`가 아니라 `other`가 된다. 문구를 바꾸기 전에 이 설정부터 확인해야 한다.

주요 옵션은 다음과 같다.

| 옵션 | 기본값 | 의미 |
|---|---|---|
| `fallbackLocale` | 없음 | 기기 로케일이 지원 목록에 없을 때 사용할 로케일 |
| `startLocale` | 없음 | 기기 로케일 대신 처음 쓸 로케일 |
| `saveLocale` | `true` | `setLocale`로 바꾼 로케일을 기기 저장소에 저장 |
| `useOnlyLangCode` | `false` | `en.json`처럼 언어 코드만으로 파일을 찾음 |
| `useFallbackTranslations` | `false` | 키가 없으면 대체 로케일 파일에서 찾음 |
| `ignorePluralRules` | `true` | `few`/`many`를 무시하고 0·1·2 값 기준으로 고름 |

## 로케일 결정 순서

공식 `Localizations`는 기기 로케일과 `supportedLocales`를 이렇게 맞춘다. 정확히 일치하는 항목이 있으면 그것을, 없으면 언어 코드가 같은 첫 항목을, 그것도 없으면 목록의 첫 항목을 쓴다. 이 규칙을 바꾸려면 `localeResolutionCallback`을 준다. gen-l10n이 만드는 `supportedLocales`는 기본적으로 알파벳순이므로, "맞는 언어가 없을 때 영어"를 원하면 `preferred-supported-locales`로 순서를 지정한다.

easy_localization 3.0.8의 초기 로케일은 다음 순서로 정해진다.

1. 저장된 로케일이 없고 `startLocale`이 있으면 `startLocale`
2. `saveLocale`이 켜져 있고 저장된 로케일이 있으면 그 값
3. 둘 다 아니면 기기 로케일

2와 3에서 로케일이 지원 목록과 맞지 않으면 언어 코드가 같은 항목, `fallbackLocale`, 목록의 첫 항목 순으로 내려간다. 사용자가 앱 안에서 언어를 한 번 바꾸면 저장된 값이 우선하므로 이후 기기 언어를 바꿔도 따라가지 않는다. 다시 기기 설정을 따르게 하려면 `context.resetLocale()`이나 `context.deleteSaveLocale()`을 호출한다.

## iOS 언어 등록

Flutter의 번역은 Dart 쪽에서 처리되므로 iOS 번들에는 `.lproj` 같은 언어 리소스가 없다. iOS는 앱이 어떤 언어를 지원하는지 따로 알아야 한다.

- Flutter 공식 문서: Xcode에서 `Runner` 프로젝트의 Info 탭 → Localizations에 언어를 추가하라고 안내한다. Xcode가 빈 `.strings` 파일을 만들고 `project.pbxproj`를 갱신하며, App Store는 이 정보로 지원 언어를 표시한다.
- easy_localization README: 번역이 iOS에서 동작하려면 `ios/Runner/Info.plist`에 지원 로케일을 추가하라고 한다.

`CFBundleLocalizations`는 Apple 문서에서 "앱이 직접 처리하는 로컬라이제이션"을 나열하는 키로 정의되어 있어, 번역을 Dart에서 처리하는 Flutter 앱의 상황과 맞는다. 두 문서의 안내가 서로 다른 설정을 가리키므로 둘 다 해 두는 것이 안전하다.

```xml
<key>CFBundleLocalizations</key>
<array>
    <string>en</string>
    <string>ko</string>
    <string>ja</string>
</array>
```

## intl로 숫자와 날짜 서식 맞추기

번역 문자열 안에 숫자와 날짜를 직접 이어 붙이면 언어마다 다른 구분 기호와 어순을 놓친다. `intl`의 `NumberFormat`과 `DateFormat`에 현재 로케일을 넘긴다.

```dart
import 'package:intl/date_symbol_data_local.dart';
import 'package:intl/intl.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await EasyLocalization.ensureInitialized();
  await initializeDateFormatting();
  // runApp ...
}

String formatScore(BuildContext context, int score) =>
    NumberFormat.decimalPattern(context.locale.toString()).format(score);

String formatDay(BuildContext context, DateTime day) =>
    DateFormat.yMMMEd(context.locale.toString()).format(day);
```

`intl` 문서는 `en_US` 외의 로케일로 날짜를 서식화하려면 `initializeDateFormatting`으로 로케일 데이터를 먼저 불러오라고 한다. `flutter_localizations`는 특정 `intl` 버전에 묶여 있으므로 공식 문서처럼 `intl: any`로 두거나 Flutter SDK가 고정한 버전과 맞춘다.

## 번역 길이와 레이아웃

W3C 국제화 문서가 인용한 IBM 지침에 따르면 영어 원문이 10자 이하인 짧은 문구는 유럽 언어로 번역될 때 평균 200~300%까지 길어지고, 70자를 넘는 긴 문장은 약 130%로 늘어난다. 짧은 버튼 라벨일수록 늘어나는 비율이 크다. 한국어·일본어는 글자 수가 줄어도 한 글자가 차지하는 폭이 넓어 가로 공간이 오히려 더 들 수 있고, 줄 높이도 더 필요하다.

| 위험 지점 | 대응 |
|---|---|
| 고정 너비 버튼 | `ConstrainedBox(minWidth)`로 최소 폭만 지정 |
| `Row` 안의 라벨 | `Flexible` 또는 `Expanded`로 감싸 줄바꿈 허용 |
| 한 줄 전제 제목 | `maxLines`와 `overflow`를 명시하고 두 줄 높이를 고려 |
| 이미지 속 글자 | 텍스트를 이미지 밖으로 분리 |
| 약어로 줄이기 | 번역자에게 원문 의미를 함께 전달 |

글자 크기 확대와 겹치는 문제가 많으므로 레이아웃 기법은 별도 글에서 자세히 다룬다.

## 번역 키 관리

- 키는 화면이나 기능 단위로 묶는다(`lesson.start`, `settings.language`). 문구를 그대로 키로 쓰면 원문을 고칠 때 키도 바뀐다.
- 문장을 조각내 이어 붙이지 않는다. 어순이 다른 언어에서는 조각의 순서를 바꿀 수 없다. 변수는 이름 인자로 문장 안에 둔다.
- easy_localization은 `dart run easy_localization:generate -f keys -o locale_keys.g.dart`로 키 상수 클래스를 만들 수 있다. 오타를 컴파일 단계에서 잡는다.
- `dart run easy_localization:audit`으로 파일 간 누락된 키를 찾는다. gen-l10n은 템플릿 ARB에 있는데 번역 파일에 없는 메시지를 `untranslated-messages-file` 옵션으로 파일에 기록할 수 있다.

## 비교

| 항목 | gen-l10n (공식) | easy_localization |
|---|---|---|
| 파일 형식 | ARB(JSON 기반) | JSON 기본, CSV/YAML/XML은 로더 패키지 |
| 로딩 시점 | 빌드 시 Dart 코드 생성 | 런타임에 에셋 로드 |
| 키 오타 | 생성된 getter라 컴파일 오류 | 문자열 키, 코드 생성 시에만 상수 |
| 복수형 | ICU `plural`, CLDR 규칙 | `plural()`, 기본은 0·1·2 값 기준 |
| 플레이스홀더 타입 | 메타데이터로 타입·서식 지정 | 문자열 치환, 서식은 `format` 인자 |
| 언어 전환 저장 | 직접 구현 | `saveLocale` 기본 제공 |
| 대체 번역 | 템플릿 기준 누락 보고 | `useFallbackTranslations` |

## 정리

1. 프레임워크 문자열은 어떤 방식을 쓰든 `flutter_localizations`의 델리게이트가 담당한다.
2. gen-l10n은 ARB에서 타입이 있는 코드를 생성하고, 생성 파일은 이제 소스 디렉터리에 둔다.
3. easy_localization은 JSON을 런타임에 읽고 언어 저장과 대체 번역을 기본 제공한다.
4. easy_localization의 `plural()`은 기본적으로 CLDR 규칙이 아니라 값 0·1·2로 고르며, 없는 하위 키는 `other`로 내려간다.
5. 초기 로케일은 저장된 값, `startLocale`, 기기 로케일, `fallbackLocale` 순서를 이해하고 설계한다.
6. iOS는 Xcode Localizations와 `CFBundleLocalizations`로 지원 언어를 등록한다.
7. 숫자·날짜는 `intl`에 로케일을 넘겨 서식화하고, 번역 길이 차이를 견디는 유연한 레이아웃을 쓴다.
