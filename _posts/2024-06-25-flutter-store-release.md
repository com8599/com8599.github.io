---
layout: post
title: Flutter 앱 스토어 배포 — 코드 서명, 빌드 번호, 출시 트랙
date: 2024-06-25
tags: [flutter]
description: pubspec 버전이 각 플랫폼의 버전 필드로 바뀌는 방식, Android와 iOS의 코드 서명 구조, TestFlight와 Play 출시 트랙을 정리한다.
---

Flutter 앱은 한 코드베이스에서 나오지만 스토어 배포는 두 플랫폼의 규칙을 각각 따른다. 버전 번호를 매기는 방식, 바이너리에 서명하는 방식, 사용자에게 내보내기 전에 테스트하는 경로가 모두 다르다. 이 글은 `pubspec.yaml`의 버전 한 줄이 어떻게 두 플랫폼의 필드로 나뉘는지, 서명 키와 인증서가 각각 무엇을 증명하는지, 그리고 TestFlight와 Google Play 출시 트랙(Track)이 어떤 단계로 쓰이는지를 다룬다.

## 버전 이름과 빌드 번호

모든 스토어는 버전을 두 가지로 관리한다. 사용자에게 보이는 버전 이름과, 스토어와 OS가 "어느 쪽이 더 새 빌드인가"를 판단하는 내부 번호다. Flutter는 이 둘을 `pubspec.yaml`의 `version` 한 줄에 함께 적는다.

```yaml
version: 1.4.2+37
```

`+` 앞의 `1.4.2`가 버전 이름, 뒤의 `37`이 빌드 번호다. 빌드할 때 Flutter가 이 값을 각 플랫폼의 필드로 옮긴다.

| pubspec | Android | iOS | 역할 |
|---|---|---|---|
| `1.4.2` (build-name) | `versionName` | `CFBundleShortVersionString` | 스토어와 설정 화면에 보이는 버전 |
| `37` (build-number) | `versionCode` | `CFBundleVersion` | 업로드와 업데이트 판단에 쓰는 번호 |

Android 쪽은 Flutter 도구가 이 값을 `android/local.properties`의 `flutter.versionCode`, `flutter.versionName`으로 기록하고 템플릿의 `android/app/build.gradle`이 그것을 읽어 쓰며, iOS 쪽은 `Info.plist`의 두 키가 `$(FLUTTER_BUILD_NAME)`, `$(FLUTTER_BUILD_NUMBER)` 빌드 변수를 참조한다. 그래서 보통은 네이티브 파일을 직접 고치지 않는다.

빌드 시점에 값을 덮어쓸 수도 있다. `--build-name`은 버전 이름을, `--build-number`는 빌드 번호를 바꾸며 `pubspec.yaml`보다 우선한다. CI에서는 버전 이름은 파일에 두고 빌드 번호만 파이프라인 실행 번호로 주는 구성이 흔하다.

```bash
flutter build appbundle --release --build-number="$CI_PIPELINE_IID"
flutter build ipa --release --build-number="$CI_PIPELINE_IID"
```

두 플랫폼의 번호 규칙은 조금 다르다.

- **Android `versionCode`**: 양의 정수이며 클수록 새 버전이다. Play는 이미 쓴 `versionCode`로 다시 업로드하는 것을 허용하지 않고, 최댓값은 2100000000이다. 기기도 더 낮은 `versionCode`로의 설치(다운그레이드)를 막는다.
- **iOS `CFBundleVersion`**: App Store Connect에 올리는 빌드마다 고유해야 한다. 같은 1.4.2를 여러 번 올리면 빌드 번호만 올려서 구분한다.

두 플랫폼에 같은 빌드 번호를 쓰고 업로드할 때마다 하나씩 올리는 단순한 규칙이 가장 덜 헷갈린다. 사람이 버전 이름을 올릴 때마다 빌드 번호를 1로 되돌리는 방식은 Android에서 곧바로 충돌한다.

## Android 코드 서명: 업로드 키와 앱 서명 키

Android는 APK에 서명한 인증서로 앱의 동일성을 판단한다. 업데이트는 이전 버전과 같은 키로 서명되어야 설치된다. 이 키를 잃어버리면 같은 패키지로 업데이트를 낼 수 없었기 때문에, Google Play는 Play 앱 서명(Play App Signing)으로 키를 둘로 나눴다.

| 키 | 보관 위치 | 용도 | 분실 시 |
|---|---|---|---|
| 업로드 키(Upload Key) | 개발자 | Play Console에 올리는 AAB에 서명. Google이 업로더 신원을 확인 | Play Console에서 재설정 요청 가능 |
| 앱 서명 키(App Signing Key) | Google | 사용자 기기에 전달되는 최종 APK에 서명 | Google이 보관하므로 개발자가 잃을 일이 없음 |

Google Play는 2021년 8월부터 신규 앱을 Android App Bundle(AAB)로 제출하도록 요구했고, AAB 배포는 Play 앱 서명을 전제로 한다. 앱 번들을 올리는 신규 앱은 기본적으로 Play 앱 서명에 등록된다. Play가 AAB에서 기기별 APK를 생성하고 앱 서명 키로 서명해 배포하는 구조다.

이 구조에서 놓치기 쉬운 점은 **사용자 기기에 설치된 앱의 서명 인증서가 업로드 키가 아니라 앱 서명 키라는 것**이다. 서명 인증서의 SHA-256 지문을 등록해야 하는 곳(App Links의 `assetlinks.json`, 일부 OAuth·지도 SDK 설정)에는 Play Console의 앱 서명 페이지에 나오는 앱 서명 키 지문을 넣어야 한다. 로컬 키스토어에서 뽑은 지문만 넣으면 직접 빌드한 APK는 되는데 스토어에서 받은 앱은 안 되는 상황이 생긴다.

### 업로드 키 만들기와 key.properties

업로드 키는 `keytool`로 만든다.

```bash
keytool -genkey -v -keystore ~/upload-keystore.jks -keyalg RSA \
        -keysize 2048 -validity 10000 -alias upload
```

키스토어 경로와 비밀번호는 `android/key.properties`에 두고 Gradle이 읽게 한다. 이 파일과 `.jks`는 저장소에 커밋하지 않는다.

```properties
storePassword=********
keyPassword=********
keyAlias=upload
storeFile=/Users/builder/upload-keystore.jks
```

`android/app/build.gradle`에서 이 파일을 읽어 release 서명 설정을 만든다. Flutter 템플릿은 기본적으로 release 빌드에도 debug 서명을 쓰도록 되어 있으므로 이 부분을 바꿔야 한다.

```groovy
def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('key.properties')
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {
    signingConfigs {
        release {
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
            storeFile keystoreProperties['storeFile'] ? file(keystoreProperties['storeFile']) : null
            storePassword keystoreProperties['storePassword']
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
```

CI에서는 키스토어를 Base64 문자열로 비밀 변수에 넣고, 빌드 직전에 파일로 복원한 뒤 `key.properties`를 생성하는 방식을 많이 쓴다. Gradle 설정을 바꾼 뒤 이전 빌드 결과가 남아 서명이 반영되지 않으면 `flutter clean` 후 다시 빌드한다.

## iOS 코드 서명: 인증서와 프로비저닝 프로필

iOS는 서명에 두 가지 자료가 필요하다.

- **인증서(Certificate)**: 서명한 주체가 Apple 개발자 프로그램의 어느 팀인지 증명한다. 개발 기기 실행용 Apple Development와, 테스트 배포·App Store Connect 제출용 Apple Distribution이 있다. 개인 키는 인증서를 만든 Mac의 키체인에 있다.
- **프로비저닝 프로필(Provisioning Profile)**: 어떤 App ID(번들 ID)를, 어떤 인증서로 서명해, 어떤 기기나 배포 방식으로 설치할 수 있는지 묶은 파일이다. 푸시 알림, Associated Domains 같은 기능(Capability)도 App ID와 프로필에 반영되어야 앱에서 쓸 수 있다.

Xcode의 Runner 타깃 Signing & Capabilities 탭에서 "Automatically manage signing"은 기본으로 켜져 있고, 대부분의 앱은 이것으로 충분하다. Team만 지정하면 Xcode가 필요한 인증서와 프로필을 만들고 갱신한다. 여러 사람이나 CI 머신이 같은 배포 인증서를 공유해야 할 때는 수동 서명으로 전환하고 인증서(.p12)와 프로필을 비밀 저장소에서 내려받아 설치하는 방식을 쓴다.

```bash
flutter build ipa --release --obfuscate --split-debug-info=build/symbols
xcrun altool --upload-app --type ios -f build/ios/ipa/*.ipa \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
```

`flutter build ipa`는 `build/ios/archive/`에 `.xcarchive`를, `build/ios/ipa/`에 App Store용 `.ipa`를 만든다. 업로드는 Transporter 앱, `xcrun altool`, Xcode Organizer 중 하나로 한다. `--obfuscate`를 쓰면 `--split-debug-info`로 남긴 심볼 파일을 보관해야 크래시 스택을 해석할 수 있다.

## TestFlight: 내부 테스트와 외부 테스트

App Store Connect에 올린 빌드는 처리(Processing)가 끝나면 TestFlight에서 배포할 수 있다.

| 구분 | 내부 테스트 | 외부 테스트 |
|---|---|---|
| 대상 | App Store Connect 사용자(팀 구성원) | 이메일 초대나 공개 링크로 들어온 누구나 |
| 인원 | 최대 100명 | 최대 10,000명 |
| 심사 | 없음 | 그룹에 처음 추가하는 빌드는 App Review의 베타 심사 필요 |
| 준비물 | 빌드만 있으면 됨 | 베타 앱 설명, 베타 심사 정보 |

외부 테스트는 첫 빌드만 정식 심사를 받고, 이후 빌드는 심사가 생략될 수 있다. 어느 쪽이든 빌드는 업로드 후 최대 90일 동안만 테스트할 수 있다. 내부 테스트로 팀이 먼저 확인하고, 외부 그룹으로 넓힌 뒤, 같은 빌드를 App Store 심사에 제출하는 순서가 일반적이다.

## Google Play 출시 트랙

Play Console은 트랙마다 다른 사용자 집합에 릴리스를 배포한다.

| 트랙 | 대상 | 특징 |
|---|---|---|
| 내부 테스트(Internal) | 이메일로 지정한 최대 100명 | 업로드 후 수 분 내 배포, 일반 심사를 거치지 않을 수 있음 |
| 비공개 테스트(Closed) | 이메일 목록이나 Google 그룹 | 트랙을 여러 개 둘 수 있음 |
| 공개 테스트(Open) | 링크로 참여하는 누구나 | Play 스토어에서 테스트 참여 가능, 인원 상한 설정 가능 |
| 프로덕션(Production) | 모든 사용자 | 단계적 출시, 국가 지정 가능 |

### 단계적 출시

프로덕션, 공개 테스트, 비공개 테스트 트랙은 단계적 출시(Staged Rollout)를 지원한다. 지정한 비율의 사용자(신규와 기존 사용자 중 무작위)만 새 버전을 받는다.

- 비율은 자동으로 오르지 않는다. 크래시와 ANR 지표를 보고 직접 올린다.
- 문제가 생기면 출시를 중단(Halt)할 수 있다. 이미 받은 사용자의 앱은 그대로 남고, 새 사용자에게만 배포가 멈춘다.
- 되돌리기 기능은 따로 없다. 수정한 번들을 더 높은 `versionCode`로 새로 출시해야 한다.
- 앱을 처음 게시할 때는 단계적 출시를 쓸 수 없다.

### 2024년의 제출 조건

**타깃 API 수준**: 2024년 8월 31일부터 새 앱과 앱 업데이트는 Android 14(API 수준 34) 이상을 타깃해야 제출할 수 있다(Wear OS, Android TV는 API 33). 기존 앱은 API 33 이상을 타깃해야 더 높은 Android 버전을 쓰는 신규 사용자에게 계속 노출된다. 시간이 더 필요하면 2024년 11월 1일까지 연장을 요청할 수 있다. Flutter 앱은 `targetSdkVersion`을 템플릿의 `flutter.targetSdkVersion`에 맡기는 경우가 많으므로, 사용하는 Flutter SDK가 어느 값을 넣는지 확인하고 필요하면 직접 지정한다.

**신규 개인 개발자 계정의 테스트 요건**: 2023년 11월 13일 이후 만든 개인(Personal) 개발자 계정은 프로덕션에 앱을 배포하기 전에 비공개 테스트를 거쳐야 한다. 이 글을 쓰는 시점 기준으로 최소 20명의 테스터가 14일 동안 연속으로 테스트에 참여(opt-in)한 상태를 유지해야 하고, 그 뒤 Play Console 대시보드에서 프로덕션 액세스를 신청한다. 조직(Organization) 계정에는 적용되지 않는다. 개인 계정으로 첫 출시를 계획한다면 일정에 최소 2주 이상의 비공개 테스트 기간을 넣어야 한다.

## 배포 흐름 비교

| 항목 | Android(Google Play) | iOS(App Store) |
|---|---|---|
| 사용자 노출 버전 | `versionName` | `CFBundleShortVersionString` |
| 내부 번호 규칙 | 정수, 이전보다 커야 함, 재사용 불가 | 업로드마다 고유 |
| 업로드 형식 | AAB | IPA |
| 개발자가 보관하는 서명 자료 | 업로드 키(분실 시 재설정 가능) | 배포 인증서 개인 키, 프로비저닝 프로필 |
| 기기에 설치되는 앱의 서명 | Google이 보관한 앱 서명 키 | 개발자의 배포 인증서로 서명한 빌드를 App Store가 배포 |
| 빠른 내부 배포 | 내부 테스트 트랙 | TestFlight 내부 테스트 |
| 외부 테스트 | 비공개·공개 테스트 트랙 | TestFlight 외부 테스트(첫 빌드 심사) |
| 점진 배포 | 단계적 출시(비율 지정) | 단계적 출시(Phased Release, 7일 자동 진행) |

App Store의 단계적 출시(Phased Release)는 자동 업데이트를 켠 사용자에게 7일에 걸쳐 정해진 비율로 업데이트를 내보내는 기능으로, 최대 30일까지 일시 정지할 수 있다. 비율을 직접 정하는 Play의 단계적 출시와 달리 일정이 고정되어 있다.

## 정리

1. `pubspec.yaml`의 `version: x.y.z+N`에서 앞부분은 `versionName`/`CFBundleShortVersionString`, 뒷부분은 `versionCode`/`CFBundleVersion`이 된다. CI에서는 `--build-number`로 빌드 번호만 주입한다.
2. 빌드 번호는 두 플랫폼 공통으로 업로드마다 올린다. Android는 재사용과 감소를 허용하지 않는다.
3. Play 앱 서명에서 개발자는 업로드 키만 보관하고, 기기에 설치되는 앱은 Google이 가진 앱 서명 키로 서명된다. 지문을 등록하는 곳에는 앱 서명 키 지문을 넣는다.
4. `key.properties`와 키스토어는 저장소 밖에 두고, release `signingConfig`가 debug로 남아 있지 않은지 확인한다.
5. iOS는 인증서(누가)와 프로비저닝 프로필(무엇을, 어디에)이 함께 있어야 서명되며, 대부분은 Xcode 자동 서명으로 충분하다.
6. TestFlight 내부 테스트는 심사 없이 100명, 외부 테스트는 첫 빌드 심사 후 10,000명까지, 빌드는 90일간 유효하다.
7. Play는 내부 → 비공개 → 공개 → 프로덕션 트랙과 단계적 출시로 노출 범위를 넓히며, 2024년 8월 31일부터 API 34 타깃 요건과 신규 개인 계정의 비공개 테스트 요건을 함께 챙겨야 한다.
