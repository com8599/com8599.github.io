---
layout: post
title: 딥 링크(Deep Link) — App Links, Universal Links와 푸시 클릭 라우팅
date: 2024-09-03
tags: [flutter]
description: 커스텀 스킴과 검증된 링크의 차이, assetlinks.json과 apple-app-site-association 설정, Flutter에서 링크와 푸시 클릭을 같은 라우터로 처리하는 방법.
---

딥 링크는 앱의 첫 화면이 아니라 특정 화면으로 바로 들어가는 링크다. 공유한 영상 링크를 누르면 그 영상이, 댓글 알림을 누르면 그 댓글이 열려야 한다. 링크가 들어오는 경로는 웹 URL, 다른 앱, 푸시 알림 등 여러 가지지만, 앱 안에서 보면 결국 "이 경로로 화면을 구성하라"는 요청 하나다. 이 글은 링크를 앱으로 가져오는 OS 쪽 장치와, 들어온 경로를 Flutter 라우터로 처리하는 방법을 정리한다.

## 커스텀 스킴과 검증된 링크

앱이 링크를 받는 방법은 크게 두 가지다.

**커스텀 URL 스킴(Custom URL Scheme)**은 `myapp://video/123`처럼 앱이 정한 스킴을 OS에 등록하는 방식이다. 설정이 간단하지만 그 스킴이 이 앱의 것이라는 증명이 없다. Apple 문서도 역방향 DNS 형태로 이름을 지어도 다른 앱이 같은 스킴을 등록하는 것을 막을 수 없다고 설명하고, 커스텀 스킴보다 Universal Links를 강하게 권장한다. 또 앱이 설치되어 있지 않으면 링크가 아무 곳으로도 가지 않는다.

**검증된 링크(Verified Link)**는 `https://example.com/video/123` 같은 일반 웹 URL을 앱이 처리하는 방식이다. Android에서는 App Links, iOS에서는 Universal Links라고 부른다. 도메인 소유자가 웹 서버에 "이 앱이 이 도메인의 링크를 처리해도 된다"는 파일을 올리고, OS가 그 파일을 확인한 뒤에야 링크를 앱으로 보낸다. 앱이 없으면 같은 URL이 웹 페이지로 열리므로 링크가 끊기지 않는다.

## Android App Links

### 인텐트 필터

`AndroidManifest.xml`의 액티비티에 `autoVerify="true"`가 붙은 인텐트 필터를 선언한다. `VIEW` 액션, `DEFAULT`와 `BROWSABLE` 카테고리, `http`나 `https` 스킴이 모두 있어야 검증 대상이 된다.

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" />
    <data android:host="example.com" />
    <data android:pathPrefix="/video" />
</intent-filter>
```

앱을 설치하면 시스템이 인텐트 필터에 나온 호스트마다 `https://<호스트>/.well-known/assetlinks.json`을 요청해 검증한다. Android 11 이하는 매니페스트에 선언한 모든 호스트가 검증되어야 앱을 기본 처리기로 지정했고, Android 12부터는 호스트별로 검증 결과를 따로 관리한다.

### assetlinks.json

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.example.app",
    "sha256_cert_fingerprints": [
      "14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42:E6:1D:BE:A8:8A:04:96:B2:3F:CF:44:E5"
    ]
  }
}]
```

`sha256_cert_fingerprints`에는 **사용자 기기에 설치된 앱의 서명 인증서** 지문이 들어가야 한다. Play 앱 서명을 쓰면 로컬 키스토어로 뽑은 지문과 실제 설치본의 지문이 다르므로, Play Console의 앱 서명 페이지에 나오는 지문(또는 그 페이지가 제공하는 Digital Asset Links 스니펫)을 쓴다. 배열이므로 디버그 키, 업로드 키 지문을 함께 넣어 개발 빌드에서도 검증되게 할 수 있다.

호스팅 조건은 다음과 같다.

- `https://<도메인>/.well-known/assetlinks.json` 경로, HTTPS로 접근 가능해야 한다. 인텐트 필터가 `http`만 선언해도 마찬가지다.
- `Content-Type: application/json`으로 응답한다.
- 301, 302 같은 리다이렉트 없이 바로 응답해야 한다.
- 여러 호스트를 처리하면 호스트마다 파일을 올린다. `www.example.com`과 `example.com`은 다른 호스트다.

검증 상태는 기기에서 직접 확인한다.

```bash
adb shell pm verify-app-links --re-verify com.example.app
adb shell pm get-app-links com.example.app
```

결과에서 도메인 상태가 `verified`가 아니면 링크가 앱 선택 대화상자나 브라우저로 간다. `none`은 아직 검증이 끝나지 않았다는 뜻이므로 잠시 뒤 다시 확인한다.

## iOS Universal Links

### Associated Domains

Xcode의 Signing & Capabilities에서 Associated Domains 기능을 추가하고 `applinks:<도메인>`을 등록한다. 이 기능은 App ID에 반영되어야 하므로 개인(Personal) 개발 팀에서는 쓸 수 없다.

```xml
<key>com.apple.developer.associated-domains</key>
<array>
    <string>applinks:example.com</string>
</array>
```

### apple-app-site-association

파일 이름은 확장자 없이 `apple-app-site-association`이며, 앱 ID는 `<팀 ID>.<번들 ID>` 형식이다.

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["ABCDE12345.com.example.app"],
        "components": [
          { "/": "/video/*", "comment": "영상 상세" },
          { "/": "/user/*" }
        ]
      }
    ]
  }
}
```

`components`의 `/` 키가 경로 패턴이고 `*`는 임의의 문자열에 맞는다. 앱이 처리하지 않는 경로까지 `/*`로 열어 두면 웹에서 보여야 할 페이지까지 앱으로 넘어가므로 처리하는 경로만 적는다.

호스팅 조건은 다음과 같다.

- `https://<도메인>/.well-known/apple-app-site-association`에 유효한 인증서의 HTTPS로, 리다이렉트 없이 제공한다.
- iOS 14부터 기기는 웹 서버에 직접 요청하지 않고 Apple이 운영하는 CDN을 거쳐 파일을 받는다. CDN은 24시간 안에 도메인의 파일을 가져가고, 기기는 설치 후 대략 일주일에 한 번 갱신을 확인한다. 파일을 고친 직후 바로 반영되지 않는 이유다.
- 공개 인터넷에서 접근할 수 없는 개발 서버는 엔타이틀먼트에 대체 모드(alternate mode)를 지정해 CDN을 우회할 수 있다.

## Flutter에서 링크 받기

Flutter 엔진은 들어온 링크의 경로를 라우터에 전달하는 기본 처리기를 갖고 있다. 이 글을 쓰는 시점의 Flutter(3.24)에서는 이 기능을 켜려면 플랫폼별 설정이 필요하다.

```xml
<meta-data android:name="flutter_deeplinking_enabled" android:value="true" />
```

```xml
<key>FlutterDeepLinkingEnabled</key>
<true/>
```

`app_links` 같은 서드파티 딥 링크 플러그인을 쓰면 기본 처리기와 충돌하므로 이 값을 `false`로 둔다.

### 라우터 선택

`MaterialApp`의 이름 있는 라우트(named routes)도 딥 링크를 받지만, Flutter 문서가 지적하듯 새 링크가 들어오면 현재 위치와 상관없이 항상 새 라우트를 push하고 이 동작을 바꿀 수 없다. go_router 같은 선언형 라우터는 경로를 파싱해 화면 스택 전체를 다시 구성하므로 같은 링크가 언제나 같은 화면 구성으로 이어진다.

```dart
final router = GoRouter(
  refreshListenable: authState,
  redirect: (context, state) {
    final loggedIn = authState.isLoggedIn;
    final goingToLogin = state.matchedLocation == '/login';
    if (!loggedIn && !goingToLogin) {
      return Uri(path: '/login', queryParameters: {'from': state.uri.toString()}).toString();
    }
    return null;
  },
  routes: [
    GoRoute(path: '/', builder: (context, state) => const HomeScreen()),
    GoRoute(path: '/login', builder: (context, state) => LoginScreen(from: state.uri.queryParameters['from'])),
    GoRoute(
      path: '/video/:id',
      builder: (context, state) => VideoScreen(id: state.pathParameters['id']!),
    ),
  ],
);
```

로그인이 필요한 화면으로 링크가 들어오면 `redirect`가 원래 경로를 `from`에 담아 로그인 화면으로 보내고, 로그인 후 `context.go(from)`으로 복귀한다. 링크로 들어온 경로는 외부 입력이므로 앱이 아는 경로인지, 파라미터 형식이 맞는지 검증한다. 맞지 않는 경로는 `errorBuilder`에서 홈으로 돌려보낸다.

### 콜드 스타트와 웜 스타트

앱이 꺼진 상태에서 링크로 실행되는 콜드 스타트(Cold Start)와, 이미 실행 중인 앱에 링크가 들어오는 웜 스타트(Warm Start)는 엔진이 경로를 넘기는 방식이 다르다.

| 상황 | Navigator(이름 있는 라우트) | Router(go_router 등) |
|---|---|---|
| iOS 콜드 스타트 | `initialRoute`로 `/`를 받은 뒤 곧이어 `pushRoute` | `/`로 시작한 뒤 파서가 링크 경로로 `setNewRoutePath` |
| Android 콜드 스타트 | `initialRoute`에 링크 경로가 바로 들어옴 | 링크 경로를 초기 경로로 파싱 |
| 실행 중(웜 스타트) | `pushRoute` 호출, 기존 스택 위에 쌓임 | 경로를 파싱해 페이지 스택 교체 |

선언형 라우터를 쓰면 이 차이가 라우터 안에서 흡수된다. 다만 iOS 콜드 스타트에서 `/`가 먼저 그려지므로, 스플래시나 초기화 로직이 `/`에서 무조건 다른 화면으로 이동시키면 링크 경로를 덮어쓸 수 있다. 초기화 리다이렉트는 `redirect` 한 곳에 모으는 것이 안전하다.

## 푸시 알림 클릭 라우팅

푸시 알림을 눌러 앱이 열리는 것도 딥 링크와 같은 문제다. 서버는 FCM 메시지의 `data`에 이동할 경로를 담고, 앱은 알림 클릭 이벤트에서 그 경로를 라우터에 넘긴다.

```json
{
  "message": {
    "token": "fcm-registration-token",
    "notification": { "title": "새 댓글", "body": "내 영상에 댓글이 달렸습니다." },
    "data": { "route": "/video/123?comment=987" }
  }
}
```

클릭 이벤트는 앱 상태에 따라 두 곳으로 들어온다.

- **종료 상태에서 클릭**: `FirebaseMessaging.instance.getInitialMessage()`가 그 메시지를 돌려준다. 한 번 읽으면 사라진다.
- **백그라운드에서 클릭**: `FirebaseMessaging.onMessageOpenedApp` 스트림에 메시지가 들어온다.

```dart
Future<void> setupPushRouting(GoRouter router) async {
  final initial = await FirebaseMessaging.instance.getInitialMessage();
  if (initial != null) _openFromPush(router, initial);

  FirebaseMessaging.onMessageOpenedApp.listen((message) => _openFromPush(router, message));
}

void _openFromPush(GoRouter router, RemoteMessage message) {
  final route = message.data['route'];
  if (route is String && route.startsWith('/')) {
    router.go(route);
  }
}
```

`getInitialMessage()`는 라우터가 만들어진 뒤, 첫 프레임이 그려진 다음에 처리해야 이동이 무시되지 않는다. 포그라운드에서 `flutter_local_notifications`로 직접 띄운 알림은 FCM의 클릭 이벤트로 들어오지 않으므로, 알림을 만들 때 `payload`에 같은 경로를 넣고 `onDidReceiveNotificationResponse` 콜백에서 같은 `_openFromPush` 로직으로 보낸다. 결국 링크, 푸시, 로컬 알림 세 경로가 모두 "경로 문자열 → `router.go`" 하나로 모인다.

## 지연된 딥 링크

지연된 딥 링크(Deferred Deep Link)는 앱이 설치되지 않은 사용자가 링크를 누르면 스토어로 보내고, 설치 후 첫 실행 때 원래 가려던 화면을 여는 기능이다. App Links와 Universal Links는 설치된 앱에만 동작하므로 이 기능을 제공하지 않는다.

이 용도로 많이 쓰이던 Firebase Dynamic Links는 2023년에 지원 중단이 공지되었고, 2025년 8월 25일에 서비스가 종료될 예정이다. 종료 후에는 기존 링크도 동작하지 않는다. Firebase는 설치된 앱으로의 링크만 필요하면 App Links와 Universal Links로, 설치 후 복원까지 필요하면 다른 딥 링크 서비스로 옮기도록 안내한다. 새로 설계한다면 Dynamic Links를 쓰지 않고, 직접 구현할 경우 스토어로 보내기 전 웹 페이지에서 경로를 저장하고 설치 후 첫 실행에 서버에서 되찾는 방식이 필요하다(Android는 Play 설치 리퍼러를 활용할 수 있다).

## 방식 비교

| 항목 | 커스텀 스킴 | App Links | Universal Links | 푸시 클릭 |
|---|---|---|---|---|
| 형태 | `myapp://video/1` | `https://example.com/video/1` | `https://example.com/video/1` | FCM `data.route` |
| 소유권 검증 | 없음 | `assetlinks.json` | `apple-app-site-association` | 해당 없음(앱 토큰으로 전송) |
| 앱 미설치 시 | 동작 안 함 | 웹 페이지로 열림 | 웹 페이지로 열림 | 해당 없음 |
| 서버 준비물 | 없음 | HTTPS, JSON, 리다이렉트 없음 | HTTPS, 리다이렉트 없음, Apple CDN 경유 | FCM 전송 |
| 반영 지연 | 없음 | 설치·업데이트 시 검증 | CDN 갱신 주기 | 없음 |
| Flutter 진입점 | 엔진 기본 처리기 → 라우터 | 엔진 기본 처리기 → 라우터 | 엔진 기본 처리기 → 라우터 | `getInitialMessage`, `onMessageOpenedApp` |

## 정리

1. 커스텀 스킴은 소유권 증명이 없어 다른 앱이 가로챌 수 있다. 외부에 공유되는 링크는 App Links와 Universal Links로 만든다.
2. `assetlinks.json`에는 Play 앱 서명 키의 SHA-256 지문을 넣고, HTTPS·`application/json`·리다이렉트 없음 조건을 지킨다. `pm get-app-links`로 검증 상태를 확인한다.
3. `apple-app-site-association`은 확장자 없이 HTTPS로, 리다이렉트 없이 제공하고, Apple CDN 때문에 변경이 늦게 반영된다는 점을 감안한다.
4. Flutter에서는 `flutter_deeplinking_enabled`/`FlutterDeepLinkingEnabled`를 켜고 go_router 같은 선언형 라우터로 경로를 받는다. 로그인 같은 조건은 `redirect` 한 곳에서 처리한다.
5. 콜드 스타트와 웜 스타트는 엔진이 경로를 넘기는 방식이 다르므로, 초기화 로직이 링크 경로를 덮어쓰지 않게 한다.
6. 푸시 클릭은 `getInitialMessage()`와 `onMessageOpenedApp`에서 `data.route`를 꺼내 같은 라우터로 보낸다. 로컬 알림도 같은 경로로 모은다.
7. 지연된 딥 링크는 검증된 링크로 해결되지 않으며, Firebase Dynamic Links는 2025년 8월 종료 예정이므로 새 설계에 쓰지 않는다.
