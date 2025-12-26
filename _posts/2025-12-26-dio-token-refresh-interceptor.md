---
layout: post
title: Dio 인터셉터로 토큰 갱신하기 — 동시에 401이 났을 때 요청 대기열 처리
date: 2025-12-26
tags: [flutter]
description: Dio 5.x의 Interceptor와 QueuedInterceptor 동작을 바탕으로, 동시에 실패한 요청들이 토큰 갱신을 한 번만 하고 재시도되도록 만드는 방법.
---

액세스 토큰이 만료되는 순간 화면 하나가 API를 서너 개 동시에 호출하고 있다면, 그 요청들은 거의 동시에 `401 Unauthorized`를 받는다. 각 요청이 제각기 리프레시 토큰으로 갱신을 시도하면 갱신 요청이 여러 번 나간다. 서버가 리프레시 토큰을 회전(rotation)시키고 재사용을 탐지한다면, 두 번째 갱신 요청은 이미 사용된 토큰을 보낸 셈이 되어 토큰 계열 전체가 폐기되고 사용자는 로그아웃된다. 서버 쪽 회전과 재사용 탐지는 [JWT 리프레시 토큰 회전 글](/2023/03/28/jwt-refresh-token-rotation/)에서 다뤘다.

클라이언트가 지켜야 할 조건은 세 가지다. 갱신은 한 번에 하나만 실행한다(single-flight). 갱신을 기다린 요청들은 새 토큰으로 재시도한다. 갱신이 실패하면 대기 중인 요청을 모두 실패시키고 세션을 끝낸다. 이 글은 `dio` 5.9.0과 `flutter_secure_storage` 9.2.4 기준으로 이 조건을 구현한다.

## Interceptor와 QueuedInterceptor

`dio`의 인터셉터는 요청 전(`onRequest`), 응답 후(`onResponse`), 오류 시(`onError`)에 끼어든다. 각 콜백은 핸들러를 받아 흐름을 정한다.

| 핸들러 메서드 | 의미 |
|---|---|
| `handler.next(x)` | 다음 인터셉터로 넘김 |
| `handler.resolve(response)` | 이 응답으로 요청을 성공 처리하고 나머지 인터셉터를 건너뜀 |
| `handler.reject(error)` | 이 오류로 요청을 실패 처리 |

핸들러는 한 번만 호출할 수 있다. 두 번 호출하면 `The handler has already been called` 메시지의 `StateError`가 발생한다. 반대로 어떤 경로에서도 호출하지 않으면 해당 요청의 `Future`는 끝나지 않는다.

공식 문서는 두 종류의 인터셉터를 이렇게 구분한다. `Interceptor`는 동시에 실행될 수 있어서 모든 요청이 한꺼번에 인터셉터에 들어온다. `QueuedInterceptor`는 요청이 순차적으로 인터셉터에 들어오게 한다. 소스 주석에 따르면 `onRequest`, `onResponse`, `onError`는 **각각 별도의 큐**에서 처리되고, 세 큐는 서로 병렬로 돈다. 한 큐 안에서는 앞선 항목의 핸들러가 호출되어야 다음 항목이 처리된다.

이 성질 때문에 두 가지 구현이 가능하다.

- `Interceptor` + `Completer`: 요청은 동시에 들어오되, 진행 중인 갱신 작업 하나를 모두가 함께 기다린다.
- `QueuedInterceptor`: 오류 콜백이 하나씩 처리되므로, 앞선 요청이 갱신을 끝낸 뒤 다음 요청은 "토큰이 이미 바뀌었는지"만 확인하고 재시도한다.

## 토큰 저장소

토큰은 `flutter_secure_storage`에 둔다. 9.x 문서에 따르면 iOS는 키체인(Keychain)에 저장하고, Android는 값을 AES로 암호화하고 그 AES 키를 RSA로 암호화해 RSA 키를 키스토어(KeyStore)에 둔다. `AndroidOptions(encryptedSharedPreferences: true)`를 주면 EncryptedSharedPreferences를 쓴다. 이 옵션은 개별 호출이 아니라 생성자에 넘겨야 섞어 쓰는 오류를 피할 수 있다.

```dart
class TokenStore {
  TokenStore(this._storage);

  final FlutterSecureStorage _storage;
  String? _access;
  String? _refresh;

  Future<String?> get accessToken async =>
      _access ??= await _storage.read(key: 'access_token');

  Future<String?> get refreshToken async =>
      _refresh ??= await _storage.read(key: 'refresh_token');

  Future<void> save(String access, String refresh) async {
    _access = access;
    _refresh = refresh;
    await _storage.write(key: 'access_token', value: access);
    await _storage.write(key: 'refresh_token', value: refresh);
  }

  Future<void> clear() async {
    _access = _refresh = null;
    await _storage.delete(key: 'access_token');
    await _storage.delete(key: 'refresh_token');
  }
}
```

모든 요청마다 키체인을 읽지 않도록 메모리에 캐시한다. `deleteAll()` 대신 토큰 키만 지우면 같은 저장소에 둔 다른 설정값을 보존할 수 있다. 백그라운드에서 토큰을 읽어야 한다면 iOS 접근성 옵션을 확인한다. 기본값은 기기가 잠금 해제된 상태에서만 접근 가능(`unlocked`)이며, 백그라운드 접근이 필요하면 `first_unlock` 계열을 쓴다. Android 자동 백업은 복원 후 `Failed to unwrap key` 오류를 일으킬 수 있으므로 문서는 자동 백업을 끄거나 저장소 파일을 백업에서 제외하라고 안내한다.

2025년 12월에 나온 10.0.0은 Jetpack Crypto 지원 중단에 맞춰 `encryptedSharedPreferences`를 deprecated로 바꾸고 기본 암호 방식을 AES-GCM으로 변경했으며, Android 최소 SDK를 23으로 올렸다. 기존 데이터는 기본적으로 새 방식으로 자동 이전된다. 메이저 업그레이드이므로 이전 동작을 실기기에서 확인한 뒤 올린다.

## Completer로 갱신을 한 번만 실행하기

```dart
class AuthInterceptor extends Interceptor {
  AuthInterceptor({
    required Dio dio,
    required Dio refreshDio,
    required TokenStore tokens,
    required void Function() onSessionExpired,
  })  : _dio = dio,
        _refreshDio = refreshDio,
        _tokens = tokens,
        _onSessionExpired = onSessionExpired;

  final Dio _dio;
  final Dio _refreshDio;
  final TokenStore _tokens;
  final void Function() _onSessionExpired;

  Completer<String?>? _refreshing;

  static const _retriedKey = 'auth_retried';

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final token = await _tokens.accessToken;
    if (token != null) options.headers['Authorization'] = 'Bearer $token';
    handler.next(options);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final options = err.requestOptions;
    final isUnauthorized = err.response?.statusCode == 401;
    if (!isUnauthorized || options.extra[_retriedKey] == true) {
      return handler.next(err);
    }

    final newToken = await _refreshOnce();
    if (newToken == null) return handler.next(err);

    options.extra[_retriedKey] = true;
    if (options.data is FormData) {
      options.data = (options.data as FormData).clone();
    }
    try {
      final response = await _dio.fetch<dynamic>(options);
      handler.resolve(response);
    } on DioException catch (e) {
      handler.next(e);
    }
  }

  Future<String?> _refreshOnce() {
    final inFlight = _refreshing;
    if (inFlight != null) return inFlight.future;

    final completer = Completer<String?>();
    _refreshing = completer;
    _refresh().then(completer.complete).whenComplete(() => _refreshing = null);
    return completer.future;
  }

  Future<String?> _refresh() async {
    final refresh = await _tokens.refreshToken;
    if (refresh == null) return _expire();
    try {
      final res = await _refreshDio.post<Map<String, dynamic>>(
        '/auth/refresh',
        data: <String, dynamic>{'refreshToken': refresh},
      );
      final body = res.data!;
      final access = body['accessToken'] as String;
      await _tokens.save(access, body['refreshToken'] as String);
      return access;
    } catch (_) {
      return _expire();
    }
  }

  Future<String?> _expire() async {
    await _tokens.clear();
    _onSessionExpired();
    return null;
  }
}
```

동작 순서는 다음과 같다.
1. 요청 A, B, C가 동시에 401을 받는다. 일반 `Interceptor`이므로 세 `onError`가 함께 실행된다.
2. 처음 도착한 A가 `_refreshing`에 `Completer`를 만들고 갱신을 시작한다. B와 C는 `_refreshing`이 이미 있으므로 같은 `future`를 기다린다. Dart의 이벤트 루프는 단일 스레드라서 `_refreshing` 확인과 대입 사이에 다른 콜백이 끼어들지 않는다.
3. 갱신이 끝나면 세 요청이 같은 새 토큰을 받고 각자 `_dio.fetch`로 재시도한다. 재시도 요청은 다시 `onRequest`를 거치며 새 토큰 헤더가 붙는다.
4. 갱신이 실패하면 세 요청 모두 `null`을 받아 원래 401 오류로 끝나고, `_onSessionExpired`는 한 번만 호출된다.

`_refresh`는 네트워크 오류뿐 아니라 응답 파싱 오류까지 모두 잡아 `null`로 끝낸다. 예외가 새어 나가면 `Completer`가 완료되지 않아 기다리던 요청이 모두 멈추기 때문이다. `extra`의 재시도 표시는 무한 루프를 막는다. 새 토큰으로 재시도했는데도 401이면 다시 갱신하지 않고 실패로 넘긴다. `FormData`는 한 번 전송되면 `finalize`된 상태라 같은 객체로 다시 보내면 `StateError`가 나므로, `dio`가 재시도용으로 제공하는 `clone()`으로 바꿔 넣는다.

## 갱신 요청은 별도 Dio로

갱신 요청을 같은 `Dio`로 보내면 갱신 엔드포인트가 401을 반환할 때 그 오류가 다시 `AuthInterceptor.onError`로 들어간다. 진행 중인 갱신을 기다리는 갱신이 되어 끝나지 않는다. 그래서 인터셉터가 없는 별도 인스턴스를 쓴다.

```dart
Dio buildApiClient(TokenStore tokens, void Function() onSessionExpired) {
  final options = BaseOptions(baseUrl: 'https://api.example.com');
  final dio = Dio(options);
  final refreshDio = Dio(options);

  dio.interceptors.add(AuthInterceptor(
    dio: dio,
    refreshDio: refreshDio,
    tokens: tokens,
    onSessionExpired: onSessionExpired,
  ));
  dio.interceptors.add(LogInterceptor(requestBody: true));
  return dio;
}
```

`dio.clone()`으로 갱신용 인스턴스를 만들면 `interceptors` 인자를 주지 않는 한 기존 인터셉터를 그대로 복사하므로, 이 용도에는 맞지 않는다. 공식 문서는 `LogInterceptor`를 항상 마지막에 추가하라고 한다. 앞에 두면 뒤따르는 인터셉터가 바꾼 헤더가 로그에 남지 않는다.

## QueuedInterceptor로 구현할 때의 함정

`dio` 저장소의 공식 예제는 `QueuedInterceptorsWrapper`로 같은 문제를 푼다. 오류 콜백이 하나씩 처리되므로, 실패한 요청에 실린 토큰과 현재 토큰을 비교해 같을 때만 갱신하고, 다르면 이미 누군가 갱신한 것으로 보고 바로 재시도한다. 갱신은 별도의 `Dio`로 보낸다.

주의할 점은 재시도 위치다. 큐는 앞선 항목의 핸들러가 호출되어야 다음 항목을 처리한다. `onError` 안에서 같은 `Dio`로 재시도한 요청이 또 실패하면, 그 오류는 같은 오류 큐의 뒤에 줄을 선다. 그런데 큐의 앞자리는 그 재시도 결과를 기다리는 현재 `onError`가 차지하고 있으므로, 둘은 서로를 기다리며 멈춘다. 재시도는 이 인터셉터가 없는 인스턴스로 보내거나, 위처럼 일반 `Interceptor`와 `Completer` 조합을 쓰는 편이 안전하다. 또한 `QueuedInterceptor`는 401과 무관한 오류까지 한 줄로 세우므로, 느린 갱신이 진행되는 동안 다른 요청의 오류 전달도 늦어진다.

## 만료 전에 미리 갱신하기

401을 받고 나서 갱신하면 첫 요청은 항상 한 번 실패한다. 액세스 토큰이 JWT라면 페이로드의 `exp`(만료 시각, 초 단위 epoch)를 읽어 만료 직전에 미리 갱신할 수 있다.

```dart
DateTime? jwtExpiry(String token) {
  final parts = token.split('.');
  if (parts.length != 3) return null;
  final payload = utf8.decode(base64.decode(base64.normalize(parts[1])));
  final exp = (jsonDecode(payload) as Map<String, dynamic>)['exp'];
  if (exp is! int) return null;
  return DateTime.fromMillisecondsSinceEpoch(exp * 1000, isUtc: true);
}

bool shouldRefresh(String token, {Duration margin = const Duration(seconds: 30)}) {
  final expiry = jwtExpiry(token);
  return expiry != null && DateTime.now().toUtc().isAfter(expiry.subtract(margin));
}
```

`base64.normalize`는 URL-safe 문자(`-`, `_`)를 표준 문자로 바꾸고 빠진 패딩을 채운다. JWT 세그먼트는 패딩 없는 base64url이므로 이 처리가 필요하다. `onRequest`에서 `shouldRefresh`가 참이면 `_refreshOnce()`를 기다린 뒤 새 토큰을 붙인다. 클라이언트는 서명을 검증하지 않고 만료 시각만 참고하는 것이며, 기기 시계가 틀릴 수 있으므로 401 기반 갱신은 그대로 남겨 둔다.

인터셉터 안에서 전역 `NavigatorKey`로 직접 화면을 옮기면 네트워크 계층이 라우팅을 알게 되고, 동시에 실패한 요청 수만큼 이동이 일어날 수 있다. 위 코드처럼 콜백이나 상태(예: 인증 상태 Provider)만 바꾸고, 라우터의 `redirect`가 그 상태를 보고 로그인 화면으로 보내게 하면 이동은 한 번만 일어난다. 401이면 무조건 저장소를 비우고 로그인으로 보내는 방식은 갱신 기회를 버리는 것이므로, 리프레시 토큰이 있는 구성에서는 갱신 실패 시에만 세션을 끝낸다.

## 방식 비교

| 항목 | 401마다 각자 갱신 | Interceptor + Completer | QueuedInterceptor + 토큰 비교 | 만료 전 선제 갱신 |
|---|---|---|---|---|
| 동시 401 시 갱신 횟수 | 요청 수만큼 | 1회 | 1회 | 1회(Completer 공유 시) |
| 회전 + 재사용 탐지 서버와의 궁합 | 나쁨(계열 폐기 위험) | 좋음 | 좋음 | 좋음 |
| 다른 오류 전달 지연 | 없음 | 없음 | 갱신 중 오류 큐 전체가 대기 | 없음 |
| 재시도 실패 시 위험 | 루프 가능 | `extra` 표시로 차단 | 같은 Dio로 재시도하면 큐 교착 | 해당 없음 |
| 첫 요청 실패 | 있음 | 있음 | 있음 | 대부분 없음 |
| 구현 난이도 | 낮음 | 중간 | 중간 | 중간(JWT 파싱, 시계 오차) |

## 정리

1. 동시에 401을 받은 요청들이 각자 갱신하면 회전·재사용 탐지 서버에서 세션 전체가 폐기될 수 있다. 갱신은 한 번에 하나만 실행한다.
2. `Interceptor`는 요청이 동시에 들어오고, `QueuedInterceptor`는 `onRequest`·`onResponse`·`onError`별 큐에서 앞 항목의 핸들러가 호출될 때까지 다음 항목을 붙잡는다. 핸들러는 정확히 한 번 호출한다.
3. 일반 `Interceptor`에서는 진행 중인 갱신을 `Completer`로 공유하고, 새 토큰으로 `dio.fetch`를 재시도한다. `extra` 표시로 재시도 루프를 막고, `FormData`는 `clone()`한다.
4. 갱신 요청은 인터셉터가 없는 별도 `Dio`로 보낸다. `clone()`은 인터셉터를 복사하므로 쓰지 않는다.
5. `QueuedInterceptor`의 `onError` 안에서 같은 `Dio`로 재시도하면 실패 시 오류 큐가 교착될 수 있다.
6. JWT `exp`로 선제 갱신하면 첫 실패를 줄일 수 있지만, 401 기반 갱신은 남겨 둔다.
7. 토큰은 `flutter_secure_storage`에 두고 메모리에 캐시한다. 갱신이 실패했을 때만 토큰을 지우고, 화면 이동은 라우터가 인증 상태를 보고 한 번만 처리한다.
