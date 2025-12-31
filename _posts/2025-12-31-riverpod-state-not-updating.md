---
layout: post
title: Riverpod에서 변경이 화면에 반영되지 않을 때 — 불변 모델, invalidate, 반환값 갱신
date: 2025-12-31
tags: [flutter]
description: Riverpod 2.x에서 상태를 바꿨는데 화면이 그대로인 원인을 알림 조건, 제자리 변경, 캐시된 Provider, void를 반환하는 변경 API로 나눠 보고 각각의 해결책을 정리한다.
---

서버에 변경 요청을 보냈고 응답도 성공했는데 화면은 이전 값을 보여 준다. 앱을 다시 실행해야 바뀐 값이 보인다. Riverpod을 쓰는 앱에서 자주 만나는 증상이다. 원인은 대부분 Riverpod이 "상태가 바뀌었다"고 판단하는 조건을 만족하지 못했거나, 바뀐 값이 화면이 구독하는 Provider까지 전달되지 않은 데 있다.

이 글은 `flutter_riverpod` 2.6.1과 `freezed` 3.2 기준이다. Riverpod 3.0은 2025년 9월 10일에 안정 버전이 나왔지만, 2.x로 시작해 아직 옮기지 않은 프로젝트가 많아 2.x 동작을 기준으로 설명하고, 3.0에서 달라지는 점은 해당 부분에 따로 적는다. `watch`·`read`·`select`의 기본 사용법은 [Flutter 상태 관리 비교 글](/2024/04/02/flutter-state-management/)에서 다뤘다.

## Riverpod이 알림을 보내는 조건

상태를 대입했다고 해서 항상 구독자에게 알림이 가는 것은 아니다. Provider마다 `updateShouldNotify`로 이전 값과 새 값을 비교한다. 2.6.1의 기본 동작은 다음과 같다.

| 대상 | 비교 방식(2.6.1) | 의미 |
|---|---|---|
| `Notifier` | `!identical(previous, next)` | 같은 인스턴스를 다시 대입하면 알림 없음. 내용이 같아도 새 인스턴스면 알림 |
| `AsyncNotifier`, `FutureProvider` | 로딩 여부가 바뀌거나, 로딩이 아닌 새 값이면 알림 | 데이터 대입은 사실상 항상 알림 |
| `ref.watch(p.select(f))` | 선택한 값을 `!=`로 비교 | 선택 결과가 `==`이면 리빌드 없음 |

`Notifier` 문서는 성능 때문에 기본 비교를 `identical`로 한다고 설명하며, 필요하면 `updateShouldNotify`를 재정의하라고 한다. Riverpod 3.0에서는 모든 Provider가 `==`로 알림을 걸러내도록 바뀌었다. 3.0으로 올리면 "내용이 같은 새 객체"도 알림을 보내지 않게 된다.

## 원인 1: 객체를 제자리에서 바꾼다

가장 흔한 원인은 상태 객체를 직접 수정한 뒤 같은 인스턴스를 다시 대입하는 것이다.

```dart
class CartNotifier extends Notifier<List<CartItem>> {
  @override
  List<CartItem> build() => [];

  void addBroken(CartItem item) {
    state.add(item);
    state = state;
  }

  void add(CartItem item) {
    state = [...state, item];
  }
}
```

`addBroken`은 리스트에 항목을 넣었지만 `state = state`는 같은 인스턴스이므로 `identical` 비교에 걸려 알림이 나가지 않는다. 화면은 다른 이유로 리빌드될 때까지 이전 개수를 보여 준다. `add`처럼 항상 새 객체를 만든다.

`select`에서도 같은 문제가 생긴다. 상태를 제자리에서 바꾸면 이전 선택값과 새 선택값이 같은 인스턴스이므로 `==`가 참이 되어 리빌드되지 않는다.

모델 클래스는 `freezed`로 불변 객체를 만드는 것이 확실하다. 3.x에서는 클래스를 `abstract` 또는 `sealed`로 선언한다.

```dart
@freezed
abstract class Profile with _$Profile {
  const factory Profile({
    required String id,
    required String nickname,
    String? characterId,
    @Default(<String>[]) List<String> badges,
  }) = _Profile;

  factory Profile.fromJson(Map<String, dynamic> json) => _$ProfileFromJson(json);
}
```

`@freezed` 클래스는 `==`와 `hashCode`가 생성되고, 리스트·맵 필드는 생성 코드에서 `DeepCollectionEquality`로 비교된다. `List`·`Map`·`Set` 필드는 기본적으로 수정 불가 컬렉션으로 감싸지므로 `profile.badges.add(...)` 같은 제자리 변경은 런타임 오류가 된다. 조용히 반영되지 않는 버그가 즉시 드러나는 오류로 바뀌는 셈이다. 변경은 `copyWith`로 한다. `copyWith(characterId: null)`처럼 `null`을 명시하면 필드를 `null`로 바꾼다. `@unfreezed`를 쓰면 필드를 수정할 수 있지만 생성된 `==`가 사라지므로 상태 모델에는 맞지 않는다.

## 원인 2: 변경 API가 결과를 돌려주지 않는다

서버에 변경을 보내는 저장소(repository) 메서드가 `Future<void>`나 `Future<bool>`을 반환하면, 호출한 쪽은 성공 여부만 알고 바뀐 모델은 모른다. 화면이 구독하는 Provider는 처음 불러온 값을 캐시하고 있으므로 아무것도 바뀌지 않는다. 앱을 다시 실행하면 Provider가 새로 만들어지며 서버 값을 읽으니 그제야 반영된다.

해결은 두 가지다. 서버가 갱신된 리소스를 응답 본문으로 돌려준다면 그 값을 상태로 대입한다. 돌려주지 않는다면 해당 Provider를 무효화해 다시 불러온다.

```dart
class ProfileRepository {
  ProfileRepository(this._dio);

  final Dio _dio;

  Future<Profile> fetchMe() async {
    final res = await _dio.get<Map<String, dynamic>>('/users/me');
    return Profile.fromJson(res.data!);
  }

  Future<Profile> updateMe(Map<String, dynamic> changes) async {
    final res = await _dio.patch<Map<String, dynamic>>('/users/me', data: changes);
    return Profile.fromJson(res.data!);
  }
}

class ProfileNotifier extends AsyncNotifier<Profile> {
  @override
  Future<Profile> build() => ref.watch(profileRepositoryProvider).fetchMe();

  Future<void> selectCharacter(String characterId) async {
    final repo = ref.read(profileRepositoryProvider);
    final updated = await repo.updateMe({'characterId': characterId});
    state = AsyncData(updated);
  }
}

final profileProvider =
    AsyncNotifierProvider<ProfileNotifier, Profile>(ProfileNotifier.new);
```

변경 메서드가 Notifier 안에 있으므로 "서버에 보냈지만 상태는 그대로"인 경로가 생기지 않는다. 위젯은 `ref.read(profileProvider.notifier).selectCharacter(id)`를 호출하고, 결과는 `ref.watch(profileProvider)`로 받는다. 위젯에서 저장소를 직접 호출하고 결과를 로컬 저장소에만 쓰는 구조라면, 같은 정보를 보여 주는 Provider는 변경을 알 방법이 없다.

## 원인 3: 다른 화면의 Provider가 이전 값을 들고 있다

자동 폐기(autoDispose)가 아닌 Provider는 컨테이너가 살아 있는 동안 값을 유지한다. 설정 화면에서 프로필을 바꾸고 홈으로 돌아왔는데 홈이 별도의 `homeSummaryProvider`에 프로필 일부를 복사해 두었다면, 그 Provider는 이전 값을 계속 보여 준다.

```dart
final homeSummaryProvider = FutureProvider<HomeSummary>((ref) async {
  final profile = await ref.watch(profileProvider.future);
  final stats = await ref.watch(statsRepositoryProvider).fetchWeekly();
  return HomeSummary(nickname: profile.nickname, stats: stats);
});
```

파생 Provider가 원본을 `ref.watch`로 의존하면 원본이 바뀔 때 함께 재계산된다. 원본을 `ref.read`로 한 번 읽어 복사하면 그 연결이 끊긴다. 같은 데이터는 한 Provider가 소유하고 나머지는 `watch`로 파생시키는 것이 원칙이다. 빌드 메서드 안에서 `ref.read`를 쓰는 실수도 같은 결과를 낸다. 값은 읽히지만 구독이 생기지 않아 이후 변경에 리빌드되지 않는다.

## invalidate와 refresh

서버가 변경 결과를 돌려주지 않거나, 한 번의 변경이 여러 Provider에 영향을 줄 때는 무효화를 쓴다.

| 메서드 | 동작(2.6.1 API 문서) | 반환값 |
|---|---|---|
| `ref.invalidate(p)` | 상태를 즉시 폐기하고, 재계산은 보통 다음 이벤트 루프 틱에 한다. 구독자가 없으면 다시 구독될 때까지 미뤄질 수 있다. 여러 번 호출해도 재계산은 한 번 | 없음 |
| `ref.refresh(p)` | 즉시 다시 계산하고 새 값을 반환한다. `invalidate` 후 `read`와 같다 | 새 값(`@useResult`) |
| `ref.invalidateSelf()` | Notifier·Provider 자신을 무효화 | 없음 |

문서는 반환값이 필요 없으면 `refresh` 대신 `invalidate`를 권한다. 동시에 여러 번 새로 고치는 것을 피할 수 있고, 당장 필요 없는 Provider는 계산을 건너뛸 수 있기 때문이다. `refresh`는 당겨서 새로 고침(pull-to-refresh)처럼 새 값을 기다려야 할 때 쓴다.

```dart
Future<void> onPullToRefresh(WidgetRef ref) => ref.refresh(profileProvider.future);

void afterCharacterChanged(WidgetRef ref) {
  ref.invalidate(profileProvider);
  ref.invalidate(trainingPlanProvider);
}
```

`family` Provider는 `ref.invalidate(planProvider(weekId))`로 특정 인자만, `ref.invalidate(planProvider)`로 그 family의 모든 인스턴스를 무효화할 수 있다. 초기화되지 않았거나 이미 폐기된 Provider에 대한 `invalidate`는 아무 효과가 없다.

## AsyncValue의 로딩과 새로 고침 상태

변경이 "늦게" 반영되거나 반대로 화면이 깜박이는 문제는 `AsyncValue`의 상태 구분에서 나온다. 2.x의 `AsyncNotifier`는 이미 값이 있는 상태에서 `AsyncLoading`이나 `AsyncError`를 대입하면 이전 값을 자동으로 합쳐(`copyWithPrevious`) 보관한다.

| 상황 | 플래그 | `when` 기본 동작 |
|---|---|---|
| 첫 로딩 | `isLoading` | `loading` 호출 |
| `invalidate`/`refresh`로 재계산 | `isLoading`, `isRefreshing` | `skipLoadingOnRefresh: true`라 이전 `data`를 계속 표시 |
| `watch` 중인 의존성이 바뀌어 재계산 | `isLoading`, `isReloading` | `skipLoadingOnReload: false`라 `loading` 표시 |
| Notifier에서 `state = const AsyncLoading()` 대입 | `isLoading`, `isReloading` | `loading` 표시 |

새로 고침 중에는 이전 데이터가 그대로 보이므로, 사용자는 반영이 안 된 것으로 느낄 수 있다. 진행 중임을 알리고 싶으면 `value.isRefreshing`으로 작은 표시기를 덧붙인다. 반대로 변경 메서드 시작에 `state = const AsyncLoading()`을 넣으면 화면 전체가 로딩으로 바뀌어 깜박인다. 버튼 단위의 진행 표시는 별도 상태로 관리하고 데이터 상태는 결과가 나왔을 때만 바꾸는 편이 낫다. 실패를 상태로 남기려면 `AsyncValue.guard`로 예외를 `AsyncError`로 바꿔 대입한다.

## select로 리빌드 범위 줄이기

변경이 반영되게 만든 다음에는 반대로 너무 많이 리빌드되지 않게 한다. 프로필 전체를 `watch`하면 닉네임만 쓰는 위젯도 배지 목록이 바뀔 때 다시 빌드된다.

```dart
final nickname = ref.watch(
  profileProvider.select((value) => value.valueOrNull?.nickname),
);
```

`select`는 선택 결과를 `==`로 비교하므로 문자열·숫자·`freezed` 모델처럼 값 비교가 되는 타입을 고른다. 선택 결과로 새 리스트를 매번 만들어 반환하면 내용이 같아도 `List`의 `==`는 동일성 비교라서 매번 리빌드된다.

## 증상별 정리

| 증상 | 원인 | 해결 |
|---|---|---|
| 상태를 바꿨는데 리빌드 안 됨 | 제자리 변경 후 같은 인스턴스 대입 | 새 객체 대입, `freezed` + `copyWith` |
| `select` 위젯만 갱신 안 됨 | 선택한 컬렉션을 제자리 변경 | 불변 컬렉션, 값 타입 선택 |
| 저장은 됐는데 재실행해야 보임 | 변경 API가 `void`/`bool` 반환, Provider 캐시 유지 | 갱신된 모델 반환 후 `state` 대입, 또는 `invalidate` |
| 다른 화면만 이전 값 | 파생 Provider가 원본을 `read`로 복사 | 원본을 `watch`로 의존 |
| 위젯이 처음 값에 고정 | `build`에서 `ref.read` 사용 | `ref.watch` |
| 새로 고침 중 이전 값이 보임 | `skipLoadingOnRefresh` 기본 `true` | `isRefreshing` 표시 추가 |
| 변경 시 화면 전체가 깜박임 | `state = const AsyncLoading()` | 진행 표시 분리, 결과만 대입 |

## 정리

1. Riverpod 2.6.1의 `Notifier`는 `identical`로, `select`는 `==`로 알림 여부를 정한다. 같은 인스턴스를 제자리에서 바꾸면 변경이 전달되지 않는다. 3.0에서는 모든 Provider가 `==`로 걸러낸다.
2. 상태 모델은 `freezed`로 불변으로 만들고 `copyWith`로 바꾼다. 생성된 `==`는 컬렉션을 깊게 비교하고, 컬렉션 필드는 기본적으로 수정할 수 없다.
3. 변경 API는 갱신된 모델을 반환하게 하고, Notifier의 메서드에서 그 값을 `state`에 대입한다. 반환하지 않는다면 관련 Provider를 `invalidate`한다.
4. 같은 데이터는 한 Provider가 소유하고, 나머지는 `ref.watch`로 파생시킨다. `read`로 복사하면 변경이 전달되지 않는다.
5. 반환값이 필요 없으면 `invalidate`, 새 값을 기다려야 하면 `refresh`를 쓴다. `family`는 전체 또는 인자별로 무효화할 수 있다.
6. 새로 고침 중에는 `when`이 이전 데이터를 보여 주는 것이 기본이다. `isRefreshing`으로 진행을 표시하고, 데이터 상태를 로딩으로 덮어써 깜박이게 만들지 않는다.
