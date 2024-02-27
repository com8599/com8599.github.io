---
layout: post
title: Flutter 위젯 생명주기와 BuildContext
date: 2024-02-27
tags: [flutter]
description: Widget, Element, RenderObject 세 트리의 역할과 State 생명주기 메서드, BuildContext와 키가 엘리먼트 재사용에 미치는 영향을 정리한다.
---

Flutter 코드를 처음 읽으면 `build()`가 생각보다 자주 호출되고, `initState`에서 `Theme.of(context)`를 부르면 오류가 나고, `await` 뒤에 `Navigator.of(context)`를 쓰면 린트 경고가 뜬다. 이 현상들은 모두 하나의 구조에서 나온다. 위젯은 설정값일 뿐이고, 실제로 화면에 살아 있는 것은 엘리먼트(Element)다. 이 글은 세 개의 트리, `State`의 생명주기, `BuildContext`의 정체, 그리고 키(Key)가 엘리먼트 재사용을 어떻게 결정하는지를 순서대로 다룬다.

## 세 개의 트리

Flutter 아키텍처 문서는 화면을 세 계층의 트리로 설명한다.

| 트리 | 기본 클래스 | 수명 | 역할 |
|---|---|---|---|
| 위젯 트리 | `Widget` | 빌드할 때마다 새로 생성 | 불변(immutable) 설정값 |
| 엘리먼트 트리 | `Element` | 프레임 사이에 유지 | 위젯의 트리 내 위치, `State` 보관, 갱신 판단 |
| 렌더 트리 | `RenderObject` | 엘리먼트가 관리 | 레이아웃과 페인트 |

위젯은 불변 클래스이므로 `Text('A')`를 `Text('B')`로 바꾸려면 새 위젯 객체를 만들어야 한다. 그렇다고 화면 아래의 표현까지 다시 만드는 것은 아니다. 빌드 단계에서 Flutter는 위젯마다 하나의 엘리먼트를 대응시키고, 엘리먼트 트리는 프레임이 바뀌어도 유지된다. 공식 문서의 표현대로 엘리먼트 트리가 실제 표현을 캐시하기 때문에 프레임워크는 위젯 계층을 "통째로 버릴 수 있는 것처럼" 다룰 수 있다.

엘리먼트는 두 종류로 나뉜다.

- `ComponentElement`: 다른 엘리먼트를 담는 호스트. `StatelessWidget`, `StatefulWidget`, `InheritedWidget`이 만든다.
- `RenderObjectElement`: 레이아웃과 페인트에 참여하며, 위젯과 실제 `RenderObject` 사이를 중개한다.

`RenderObject`는 레이아웃과 페인트의 추상 모델이다. 레이아웃은 렌더 트리를 깊이 우선으로 순회하며 부모가 자식에게 크기 제약(constraints)을 내려 주고, 자식이 그 안에서 결정한 크기를 올려 보내는 방식으로 진행된다. 그 뒤 각 객체의 `paint()`가 호출된다.

`build()`는 빠르고 부수 효과가 없도록 설계되어야 한다. 공식 문서는 프레임워크가 필요할 때마다, 많게는 렌더링되는 프레임마다 `build()`를 부를 수 있다고 설명한다. 따라서 `build()` 안에서 네트워크 요청을 시작하거나 컨트롤러를 생성하면 안 된다.

## 엘리먼트 갱신 규칙: canUpdate

부모가 다시 빌드되어 새 자식 위젯을 돌려주면, 엘리먼트는 기존 위젯 자리를 새 위젯으로 바꿔 끼울지 판단한다. 기준은 `Widget.canUpdate`다.

```dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType &&
      oldWidget.key == newWidget.key;
}
```

런타임 타입과 키가 같으면 기존 엘리먼트(와 그 엘리먼트가 가진 `State`, `RenderObject`)를 재사용하고 위젯 참조만 바꾼다. 다르면 기존 엘리먼트를 떼어 내고 새 엘리먼트를 만든다. 둘 다 키가 없으면(`null == null`) 타입만 같아도 재사용된다. 이 규칙이 뒤에서 다룰 키 문제의 원인이다.

## State 생명주기

`StatefulWidget` 자체는 불변이고, 변하는 값은 별도 객체인 `State`에 둔다. `State`는 엘리먼트에 붙어 있으므로 위젯이 새로 만들어져도 엘리먼트가 재사용되는 한 그대로 남는다.

| 단계 | 호출 시점 | 할 일 |
|---|---|---|
| `createState` | 위젯이 트리에 삽입될 때 | `State` 객체 생성 |
| `initState` | 삽입 직후 한 번 | 컨트롤러·구독 생성 등 일회성 초기화 |
| `didChangeDependencies` | `initState` 직후, 의존하는 `InheritedWidget`이 바뀔 때 | 상속 위젯에 의존하는 초기화 |
| `build` | 여러 번 | UI 기술, 부수 효과 없음 |
| `didUpdateWidget` | 부모가 같은 타입·키의 새 위젯을 줄 때 | 이전 위젯과 비교해 구독·컨트롤러 갱신 |
| `deactivate` | 서브트리가 트리에서 제거될 때 | 다른 엘리먼트와의 연결 정리 |
| `activate` | `deactivate` 후 같은 프레임 안에 다시 삽입될 때 | 연결 복구 |
| `dispose` | 현재 애니메이션 프레임이 끝날 때까지 재삽입되지 않으면 | 리소스 해제 |

`dispose` 이후 `State`는 다시 마운트될 수 없고, 이때 `setState`를 호출하면 오류다. 개발 중 핫 리로드 때는 `reassemble`이 추가로 호출된다.

```dart
class VideoTile extends StatefulWidget {
  const VideoTile({super.key, required this.url});
  final String url;

  @override
  State<VideoTile> createState() => _VideoTileState();
}

class _VideoTileState extends State<VideoTile> {
  late VideoPlayerController _controller;

  @override
  void initState() {
    super.initState();
    _controller = VideoPlayerController.networkUrl(Uri.parse(widget.url))
      ..initialize().then((_) {
        if (mounted) setState(() {});
      });
  }

  @override
  void didUpdateWidget(covariant VideoTile oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.url != widget.url) {
      _controller.dispose();
      _controller = VideoPlayerController.networkUrl(Uri.parse(widget.url))
        ..initialize().then((_) {
          if (mounted) setState(() {});
        });
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_controller.value.isInitialized) {
      return const Center(child: CircularProgressIndicator());
    }
    return AspectRatio(
      aspectRatio: _controller.value.aspectRatio,
      child: VideoPlayer(_controller),
    );
  }
}
```

`didUpdateWidget`을 빠뜨리는 실수가 흔하다. 부모가 `url`만 바꿔 다시 빌드하면 엘리먼트와 `State`는 재사용되고 `initState`는 다시 불리지 않는다. 결과적으로 화면에는 이전 영상이 계속 재생된다. `didUpdateWidget` 뒤에는 프레임워크가 항상 `build`를 호출하므로 여기서 `setState`를 부를 필요는 없다.

## BuildContext는 엘리먼트다

API 문서는 `BuildContext` 객체가 실제로는 `Element` 객체이며, 이 인터페이스는 엘리먼트를 직접 조작하지 못하게 하려고 존재한다고 설명한다. 즉 `build(BuildContext context)`로 받는 `context`는 그 위젯의 엘리먼트, 다시 말해 트리 안의 위치를 가리키는 핸들이다.

이 사실에서 두 가지가 따라 나온다.

첫째, `Theme.of(context)`나 `Navigator.of(context)`는 **그 위치에서 위쪽으로** 조상을 찾는다. `Scaffold`를 만드는 `build` 메서드의 `context`로 `Scaffold.of(context)`를 부르면 실패하는 이유가 여기 있다. 그 `context`는 `Scaffold`보다 위에 있기 때문이다. `Builder`로 감싸 한 단계 아래의 `context`를 얻으면 해결된다.

둘째, 엘리먼트는 트리에서 떨어질 수 있다. 떨어진 엘리먼트의 `context`로 조상을 찾으면 의미 없는 결과가 나오거나 예외가 발생한다.

## await 뒤의 mounted 검사

비동기 작업이 끝나기 전에 사용자가 화면을 닫으면 `State`는 이미 `dispose`된 상태일 수 있다. 그 뒤에 `context`를 쓰는 것이 `use_build_context_synchronously` 린트가 잡는 패턴이다. 이 규칙은 `flutter_lints` 2.0.0부터 기본 세트에 포함되어 있다.

```dart
Future<void> _save() async {
  await repository.save(_form);
  if (!mounted) return;
  Navigator.of(context).pop();
}
```

린트 문서는 검사 대상을 구분한다.

| `context`의 출처 | 검사할 값 |
|---|---|
| `State`의 `context` 프로퍼티 | `State.mounted` (`this.mounted`) |
| 함수 인자·지역 변수로 받은 `BuildContext` | `context.mounted` |

`StatelessWidget`의 콜백이나 헬퍼 함수처럼 `State`가 없는 곳에서는 `BuildContext.mounted`로 검사한다.

```dart
Future<void> showResult(BuildContext context, Future<String> job) async {
  final message = await job;
  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}
```

`await` 전에 `ScaffoldMessenger.of(context)`를 미리 변수에 받아 두는 방법도 있다. 이 경우 비동기 구간 뒤에는 `context`를 쓰지 않으므로 린트 대상이 아니다.

## InheritedWidget과 initState

`InheritedWidget`은 트리 아래쪽으로 값을 전달하는 기본 장치다. `Theme`, `MediaQuery`, Provider 등이 모두 이 위에 만들어져 있다.

```dart
class AppConfig extends InheritedWidget {
  const AppConfig({super.key, required this.apiBase, required super.child});
  final String apiBase;

  static AppConfig? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppConfig>();

  static AppConfig of(BuildContext context) {
    final result = maybeOf(context);
    assert(result != null, 'No AppConfig found in context');
    return result!;
  }

  @override
  bool updateShouldNotify(AppConfig oldWidget) => apiBase != oldWidget.apiBase;
}
```

`of`와 `maybeOf` 두 정적 메서드를 두고, `of`는 내부에서 `maybeOf`를 호출해 찾지 못하면 assert하는 것이 공식 문서의 관례다.

`dependOnInheritedWidgetOfExactType`은 O(1)이지만 **의존성을 등록한다**. 등록된 엘리먼트는 `updateShouldNotify`가 `true`를 돌려줄 때마다 다시 빌드되고, `State`라면 `didChangeDependencies`가 먼저 호출된다.

API 문서는 이 메서드를 위젯 생성자나 `State.initState`에서 호출하지 말라고 명시한다. `initState`는 한 번만 호출되므로, 여기서 값을 읽으면 이후 상속 위젯의 값이 바뀌어도 반영할 자리가 없다. 대신 `initState` 직후에 반드시 호출되는 `didChangeDependencies`에서 읽는다. `dispose`에서도 트리가 안정적이지 않으므로 호출하면 안 되고, `deactivate`에서는 안전하다.

```dart
@override
void didChangeDependencies() {
  super.didChangeDependencies();
  final base = AppConfig.of(context).apiBase;
  if (base != _base) {
    _base = base;
    _client = ApiClient(base);
  }
}
```

`didChangeDependencies`는 여러 번 호출될 수 있으므로 값이 실제로 바뀌었는지 비교한 뒤 비싼 작업을 한다.

## 키와 엘리먼트 재사용

키가 없으면 엘리먼트는 같은 부모 아래에서 **타입과 위치**로 위젯과 짝지어진다. 상태를 가진 같은 타입의 위젯 두 개 순서를 바꾸면, 엘리먼트는 제자리에 남고 위젯만 바뀐다. 즉 `State`가 엉뚱한 위젯에 붙는다.

```dart
class LikeTile extends StatefulWidget {
  const LikeTile({super.key, required this.title});
  final String title;

  @override
  State<LikeTile> createState() => _LikeTileState();
}

class _LikeTileState extends State<LikeTile> {
  bool liked = false;

  @override
  Widget build(BuildContext context) => ListTile(
        title: Text(widget.title),
        trailing: IconButton(
          icon: Icon(liked ? Icons.favorite : Icons.favorite_border),
          onPressed: () => setState(() => liked = !liked),
        ),
      );
}

Column(
  children: [
    for (final video in videos) LikeTile(key: ValueKey(video.id), title: video.title),
  ],
)
```

`ValueKey(video.id)`가 없으면 목록을 정렬하거나 맨 앞 항목을 삭제했을 때, 좋아요 표시가 다른 영상으로 옮겨 간 것처럼 보인다. 키를 주면 `canUpdate`가 키까지 비교하므로 엘리먼트가 해당 데이터와 함께 이동한다.

| 키 | 비교 기준 | 범위 | 용도 |
|---|---|---|---|
| `ValueKey<T>` | 값의 `==` | 같은 부모의 형제 사이 | ID가 있는 목록 항목 |
| `ObjectKey` | 객체 동일성(`identical`) | 같은 부모의 형제 사이 | 고유 값이 없고 객체 자체로 구분할 때 |
| `UniqueKey` | 자기 자신만 같음 | 같은 부모의 형제 사이 | 매 빌드마다 강제로 새 엘리먼트를 만들 때 |
| `GlobalKey` | 앱 전체에서 유일 | 앱 전체 | 다른 부모로 이동하며 상태 유지, `currentState` 접근 |

로컬 키는 같은 부모를 가진 엘리먼트 사이에서만 유일하면 된다. `GlobalKey`를 가진 위젯은 같은 애니메이션 프레임 안에 다른 위치로 옮겨지면 서브트리를 그대로 데려간다(재부모화, reparenting). 이때 `deactivate` 후 `activate`가 호출된다. 다만 재부모화는 비용이 크고, 같은 `GlobalKey`를 가진 위젯 두 개를 동시에 트리에 둘 수 없으므로 꼭 필요한 곳에만 쓴다. `build` 안에서 `UniqueKey()`나 `GlobalKey()`를 생성하면 매번 키가 달라져 상태가 계속 초기화된다.

## 정리

1. 위젯은 불변 설정값이고, 프레임 사이에 살아남는 것은 엘리먼트다. `RenderObject`는 엘리먼트가 관리하며 레이아웃과 페인트를 맡는다.
2. 엘리먼트는 `runtimeType`과 `key`가 같으면 재사용된다(`Widget.canUpdate`). 이때 `State`도 유지된다.
3. 일회성 초기화는 `initState`, 상속 위젯 의존 초기화는 `didChangeDependencies`, 위젯 속성 변경 대응은 `didUpdateWidget`, 해제는 `dispose`에서 한다.
4. `BuildContext`는 엘리먼트이며, `of(context)` 조회는 그 위치에서 위로 올라간다.
5. `await` 뒤에는 `State.mounted` 또는 `context.mounted`를 검사한다. `use_build_context_synchronously` 린트가 이를 강제한다.
6. 같은 타입의 상태 있는 위젯을 목록으로 그릴 때는 데이터 ID로 `ValueKey`를 준다. `GlobalKey`는 재부모화나 `currentState` 접근이 꼭 필요할 때만 쓴다.
