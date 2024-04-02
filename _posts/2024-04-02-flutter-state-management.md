---
layout: post
title: Flutter 상태 관리 비교 — Provider, Riverpod, BLoC
date: 2024-04-02
tags: [flutter]
description: 같은 좋아요 기능을 Provider, Riverpod 2.x, flutter_bloc 8.x로 각각 구현하며 상태 범위, 리빌드 범위, 테스트 방식을 비교한다.
---

Flutter에는 공식 상태 관리 라이브러리가 하나로 정해져 있지 않다. 공식 문서는 여러 선택지를 나열할 뿐이고, 실무에서는 Provider, Riverpod, BLoC 세 가지가 가장 자주 비교된다. 이 글은 영상 목록의 좋아요 버튼이라는 같은 기능을 세 방식으로 구현하고, 어떤 상태를 라이브러리에 맡겨야 하는지, 상태가 바뀔 때 어디까지 다시 빌드되는지, 테스트는 어떻게 하는지를 비교한다.

## 임시 상태와 앱 상태

공식 문서는 상태를 두 가지로 나눈다.

- **임시 상태(Ephemeral state)**: UI 상태 또는 로컬 상태라고도 하며, 하나의 위젯 안에 깔끔하게 담을 수 있는 상태다. `PageView`의 현재 페이지, 복잡한 애니메이션의 진행도, `BottomNavigationBar`에서 선택된 탭이 예시다.
- **앱 상태(App state)**: 임시 상태가 아니면서 앱의 여러 곳에서 공유하고, 사용자 세션 사이에도 유지하고 싶은 상태다. 공유 상태(shared state)라고도 한다. 사용자 설정, 로그인 정보, 알림, 장바구니, 기사의 읽음 여부가 예시다.

임시 상태는 `StatefulWidget`과 `setState`로 충분하다. 문서는 둘을 가르는 명확하고 보편적인 규칙은 없으며, 때로는 하나를 다른 쪽으로 리팩터링해야 한다고 말한다. 예를 들어 선택된 탭도 외부에서 바꿔야 하거나 세션 사이에 유지해야 하면 앱 상태가 된다.

좋아요 기능에 적용하면 다음과 같다.

| 값 | 분류 | 이유 |
|---|---|---|
| 하트 아이콘의 눌림 애니메이션 진행도 | 임시 상태 | 해당 버튼 위젯만 사용 |
| 영상의 좋아요 여부와 개수 | 앱 상태 | 목록, 상세 화면, 프로필 화면이 함께 사용하고 서버와 동기화 |

아래 예제는 모두 앱 상태인 좋아요 여부와 개수를 다룬다. 서버 호출은 `LikeRepository` 인터페이스로 추상화한다.

```dart
class VideoLike {
  const VideoLike({required this.liked, required this.count});
  final bool liked;
  final int count;

  VideoLike toggled() => VideoLike(liked: !liked, count: liked ? count - 1 : count + 1);

  @override
  bool operator ==(Object other) =>
      other is VideoLike && other.liked == liked && other.count == count;

  @override
  int get hashCode => Object.hash(liked, count);
}

abstract interface class LikeRepository {
  Future<void> setLiked(String videoId, bool liked);
}
```

세 예제 모두 낙관적 갱신(optimistic update)을 한다. 먼저 화면 상태를 바꾸고 서버 요청이 실패하면 되돌린다.

## Provider

Provider는 `InheritedWidget`을 감싸 객체를 트리 아래로 전달하는 라이브러리다. 변경 알림은 보통 `ChangeNotifier`로 한다.

```dart
class LikeNotifier extends ChangeNotifier {
  LikeNotifier(this._repo, this.videoId, VideoLike initial) : _like = initial;
  final LikeRepository _repo;
  final String videoId;
  VideoLike _like;
  VideoLike get like => _like;

  Future<void> toggle() async {
    final before = _like;
    _like = _like.toggled();
    notifyListeners();
    try {
      await _repo.setLiked(videoId, _like.liked);
    } catch (_) {
      _like = before;
      notifyListeners();
    }
  }
}

ChangeNotifierProvider(
  create: (context) => LikeNotifier(context.read<LikeRepository>(), video.id, video.like),
  child: const LikeButton(),
)

class LikeButton extends StatelessWidget {
  const LikeButton({super.key});

  @override
  Widget build(BuildContext context) {
    final liked = context.select<LikeNotifier, bool>((n) => n.like.liked);
    final count = context.select<LikeNotifier, int>((n) => n.like.count);
    return TextButton.icon(
      onPressed: () => context.read<LikeNotifier>().toggle(),
      icon: Icon(liked ? Icons.favorite : Icons.favorite_border),
      label: Text('$count'),
    );
  }
}
```

- `context.watch<T>()`는 `T`의 변경을 구독해 위젯을 다시 빌드한다.
- `context.read<T>()`는 구독 없이 값을 가져온다. 문서는 `build` 안에서 호출하지 말고 콜백에서 쓰라고 한다.
- `context.select<T, R>()`는 `T`의 일부만 구독해 그 값이 바뀔 때만 다시 빌드한다.
- 새 객체는 `create`로 만들고, 이미 있는 객체를 노출할 때만 `.value` 생성자를 쓴다. `create`로 만든 `ChangeNotifier`는 Provider가 필요할 때 `dispose`를 호출한다.

Provider는 `BuildContext`로 조회하므로 위젯 트리 바깥에서 상태에 접근하기 어렵고, 같은 타입의 Provider가 여러 개면 가장 가까운 것만 찾는다. 찾지 못하면 런타임 예외(`ProviderNotFoundException`)가 난다.

## Riverpod 2.x

Riverpod는 Provider 작성자가 만든 별도 라이브러리로, Provider를 `BuildContext`가 아닌 전역 선언 객체로 정의한다. 상태는 앱 루트의 `ProviderScope`에 저장된다. 동기 상태를 메서드로 바꾸는 경우 2.x에서는 `Notifier`와 `NotifierProvider`를 쓴다.

```dart
final likeRepositoryProvider = Provider<LikeRepository>((ref) => HttpLikeRepository());

final initialLikeProvider = Provider.family<VideoLike, String>((ref, videoId) {
  final video = ref.watch(videoListProvider).firstWhere((v) => v.id == videoId);
  return video.like;
});

class LikeController extends AutoDisposeFamilyNotifier<VideoLike, String> {
  @override
  VideoLike build(String videoId) => ref.watch(initialLikeProvider(videoId));

  Future<void> toggle() async {
    final before = state;
    state = state.toggled();
    try {
      await ref.read(likeRepositoryProvider).setLiked(arg, state.liked);
    } catch (_) {
      state = before;
    }
  }
}

final likeControllerProvider =
    NotifierProvider.autoDispose.family<LikeController, VideoLike, String>(LikeController.new);

class LikeButton extends ConsumerWidget {
  const LikeButton({super.key, required this.videoId});
  final String videoId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final like = ref.watch(likeControllerProvider(videoId));
    return TextButton.icon(
      onPressed: () => ref.read(likeControllerProvider(videoId).notifier).toggle(),
      icon: Icon(like.liked ? Icons.favorite : Icons.favorite_border),
      label: Text('${like.count}'),
    );
  }
}
```

`family`의 인자는 Provider 인스턴스를 구분하는 키가 되므로 `==`와 `hashCode`가 일관된 값이어야 한다. 그래서 영상 객체 대신 영상 ID(`String`)를 넘기고, 초기값은 다른 Provider에서 읽는다.

코드 생성(code generation)은 선택 사항이다. `riverpod_annotation`과 `riverpod_generator`, `build_runner`를 쓰면 위 선언을 다음처럼 줄일 수 있다. 생성된 Provider는 기본적으로 자동 폐기(autoDispose)되며, 유지하려면 `@Riverpod(keepAlive: true)`를 쓴다.

```dart
part 'like_controller.g.dart';

@riverpod
class LikeController extends _$LikeController {
  @override
  VideoLike build(String videoId) => ref.watch(initialLikeProvider(videoId));

  Future<void> toggle() async {
    final before = state;
    state = state.toggled();
    try {
      await ref.read(likeRepositoryProvider).setLiked(videoId, state.liked);
    } catch (_) {
      state = before;
    }
  }
}
```

`build`의 인자가 곧 family 인자가 되고, `likeControllerProvider(videoId)`라는 Provider가 생성된다. 공식 문서는 Notifier에 `state` 외의 공개 프로퍼티를 두지 말라고 한다. UI가 그 변경을 감지할 수 없기 때문이다. 이벤트 핸들러에서는 `ref.watch` 대신 `ref.read`를 쓴다.

## BLoC: Cubit과 Bloc

`flutter_bloc` 8.x는 `Cubit`과 `Bloc` 두 가지를 제공한다. `Cubit`은 메서드를 호출하면 `emit`으로 새 상태를 내보낸다.

```dart
class LikeCubit extends Cubit<VideoLike> {
  LikeCubit(this._repo, this.videoId, VideoLike initial) : super(initial);
  final LikeRepository _repo;
  final String videoId;

  Future<void> toggle() async {
    final before = state;
    emit(state.toggled());
    try {
      await _repo.setLiked(videoId, state.liked);
    } catch (_) {
      emit(before);
    }
  }
}
```

`Bloc`은 메서드 대신 이벤트를 받고, `on<Event>` 핸들러 안에서만 상태를 내보낸다.

```dart
sealed class LikeEvent {}
final class LikeToggled extends LikeEvent {}

class LikeBloc extends Bloc<LikeEvent, VideoLike> {
  LikeBloc(this._repo, this.videoId, VideoLike initial) : super(initial) {
    on<LikeToggled>(_onToggled, transformer: droppable());
  }
  final LikeRepository _repo;
  final String videoId;

  Future<void> _onToggled(LikeToggled event, Emitter<VideoLike> emit) async {
    final before = state;
    emit(state.toggled());
    try {
      await _repo.setLiked(videoId, state.liked);
    } catch (_) {
      emit(before);
    }
  }
}
```

`droppable()`은 `bloc_concurrency` 패키지의 이벤트 변환기(transformer)로, 처리 중에 들어온 이벤트를 버린다. 연타로 요청이 겹치는 것을 막는 데 쓸 수 있다. 공식 문서는 Cubit의 가장 큰 장점을 단순함으로, Bloc의 장점을 상태 변화의 순서와 원인을 추적할 수 있다는 점과 디바운스 같은 반응형 연산자를 핸들러 단위로 붙일 수 있다는 점으로 든다. `Bloc`에서는 `onTransition`이 `onChange`보다 먼저 호출되며, 상태 변화를 일으킨 이벤트까지 함께 전달한다.

```dart
BlocProvider(
  create: (context) => LikeCubit(context.read<LikeRepository>(), video.id, video.like),
  child: BlocBuilder<LikeCubit, VideoLike>(
    builder: (context, like) => TextButton.icon(
      onPressed: () => context.read<LikeCubit>().toggle(),
      icon: Icon(like.liked ? Icons.favorite : Icons.favorite_border),
      label: Text('${like.count}'),
    ),
  ),
)
```

`BlocProvider`는 기본적으로 Bloc을 지연 생성하고, 자신이 만든 Bloc은 자동으로 `close`한다. `BlocProvider.value`로 넘긴 Bloc은 닫지 않는다. Bloc과 Cubit 모두 `state == nextState`이면 상태 변화를 무시하므로, 상태 클래스에 값 동등성을 구현해 두어야 의도대로 동작한다.

## 리빌드 범위

세 라이브러리 모두 기본 구독은 상태 전체를 대상으로 하고, 일부만 구독하는 수단을 따로 제공한다.

| 목적 | Provider | Riverpod 2.x | flutter_bloc 8.x |
|---|---|---|---|
| 전체 구독 | `context.watch<T>()`, `Consumer<T>` | `ref.watch(p)` | `BlocBuilder`, `context.watch<B>()` |
| 일부 구독 | `context.select`, `Selector` | `ref.watch(p.select(...))` | `BlocSelector`, `buildWhen`, `context.select` |
| 구독 없이 읽기 | `context.read<T>()` | `ref.read(p)` | `context.read<B>()` |
| 일회성 반응(이동, 스낵바) | `addListener` 직접 사용 | `ref.listen` | `BlocListener` |

`select`로 고른 값은 불변이어야 한다. Riverpod 문서는 리스트를 반환한 뒤 그 리스트를 변경하면 리빌드가 일어나지 않는다고 경고한다. 또 `select`는 읽기마다 약간의 비용과 코드 복잡도를 더하므로, 다른 필드가 거의 바뀌지 않으면 쓸 이유가 적다. `BlocListener`의 `listener`는 상태 변화마다 한 번 호출되며 초기 상태에는 호출되지 않는다.

`Consumer`나 `BlocBuilder`를 트리 깊숙이, 실제로 값을 쓰는 위젯 바로 위에 두는 것만으로도 리빌드 범위는 크게 줄어든다.

## 테스트

Riverpod은 모든 Provider를 별도 설정 없이 교체(override)할 수 있다. 단위 테스트는 `ProviderContainer`로, 위젯 테스트는 `ProviderScope`로 한다. 공식 문서는 컨테이너를 테스트 사이에 공유하지 말라고 한다.

```dart
test('toggle rolls back on failure', () async {
  final container = ProviderContainer(overrides: [
    likeRepositoryProvider.overrideWithValue(FailingLikeRepository()),
    initialLikeProvider('v1').overrideWithValue(const VideoLike(liked: false, count: 3)),
  ]);
  addTearDown(container.dispose);

  final sub = container.listen(likeControllerProvider('v1'), (_, __) {});
  await container.read(likeControllerProvider('v1').notifier).toggle();
  expect(sub.read(), const VideoLike(liked: false, count: 3));
});
```

자동 폐기 Provider는 구독자가 없으면 폐기될 수 있으므로 테스트에서 `container.listen`으로 붙잡아 둔다.

BLoC은 `bloc_test` 패키지의 `blocTest`로 "어떤 행동 뒤에 어떤 상태가 순서대로 나오는가"를 선언적으로 검증한다.

```dart
blocTest<LikeCubit, VideoLike>(
  'emits liked then rolls back when the request fails',
  build: () => LikeCubit(FailingLikeRepository(), 'v1', const VideoLike(liked: false, count: 3)),
  act: (cubit) => cubit.toggle(),
  expect: () => const [
    VideoLike(liked: true, count: 4),
    VideoLike(liked: false, count: 3),
  ],
);
```

Provider의 `ChangeNotifier`는 순수 Dart 클래스이므로 직접 생성해 메서드를 호출하고 `addListener`로 알림 횟수를 세면 된다. 다만 위젯 테스트에서는 필요한 Provider를 트리에 모두 직접 배치해야 한다.

## 비교

| 항목 | Provider | Riverpod 2.x | flutter_bloc 8.x |
|---|---|---|---|
| 상태 보관 위치 | 위젯 트리(`InheritedWidget`) | `ProviderScope`/`ProviderContainer` | 위젯 트리(`BlocProvider`) |
| 조회 수단 | `BuildContext` | `ref` | `BuildContext` |
| 위젯 밖 접근 | 어려움 | `ProviderContainer`로 가능 | Bloc 인스턴스를 직접 주입 |
| 누락 시 | 런타임 예외(`ProviderNotFoundException`) | 전역 변수로 참조하므로 조회 대상 누락이 없음(루트 `ProviderScope`만 필요) | 런타임 예외 |
| 상태 변경 방식 | 가변 객체 + `notifyListeners` | 불변 `state` 교체 | 불변 상태 `emit` |
| 비동기 상태 | 직접 구현 | `AsyncNotifier`, `AsyncValue` 내장 | 상태 클래스로 직접 모델링 |
| 폐기 | `create`로 만든 경우 자동 | `autoDispose`(코드 생성 시 기본) | `BlocProvider`가 만든 경우 자동 `close` |
| 테스트 | 클래스 직접 테스트 | `overrides`로 의존성 교체 | `blocTest`로 상태 순서 검증 |
| 보일러플레이트 | 적음 | 중간(코드 생성 시 적음) | Cubit 중간, Bloc 많음 |
| 적합한 경우 | 작은 앱, 단순 공유 상태 | 의존성 그래프와 비동기 데이터가 많은 앱 | 이벤트 추적과 규칙이 중요한 팀·도메인 |

## 정리

1. 하나의 위젯 안에 담기는 임시 상태는 `setState`로 처리하고, 여러 화면이 공유하거나 세션 사이에 유지할 앱 상태만 라이브러리에 맡긴다. 둘의 경계는 고정되어 있지 않다.
2. Provider는 `InheritedWidget` 위의 얇은 계층으로, `watch`·`read`·`select` 세 가지를 구분해 쓰는 것이 핵심이다.
3. Riverpod 2.x는 Provider를 전역 선언하고 `ProviderScope`에 상태를 둔다. `Notifier`/`AsyncNotifier`를 쓰며, 코드 생성은 선택이지만 쓰면 autoDispose가 기본이다.
4. flutter_bloc 8.x의 `Cubit`은 메서드로, `Bloc`은 이벤트로 상태를 바꾼다. 추적성과 이벤트 변환기가 필요하면 `Bloc`, 아니면 `Cubit`이 단순하다.
5. 리빌드 범위는 `select` 계열(`context.select`, `p.select`, `BlocSelector`)과 구독 위젯의 위치로 줄인다. 선택한 값은 불변이어야 한다.
6. 테스트 방식이 선택 기준이 된다. Riverpod은 override, BLoC은 `blocTest`로 상태 순서를 검증한다.
