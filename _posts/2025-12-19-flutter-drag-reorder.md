---
layout: post
title: 드래그로 순서 맞추기 위젯 — Draggable, DragTarget, ReorderableListView 비교
date: 2025-12-19
tags: [flutter]
description: 섞인 단어를 끌어 문장을 완성하는 퀴즈를 예로 Draggable과 DragTarget, ReorderableListView, 패키지 기반 ReorderableWrap을 비교하고 상태 모델, 영역 제한, 드래그 없는 대체 조작을 정리한다.
---

"섞인 단어를 올바른 순서로 놓아 문장을 완성하라" 같은 문제는 학습 앱에서 자주 쓰인다. Flutter에서 이를 만드는 방법은 크게 두 가지다. 단어 은행(Bank)에서 빈칸(Slot)으로 단어를 옮기는 **끌어서 놓기(Drag and Drop)** 방식과, 이미 놓인 목록의 **순서 바꾸기(Reorder)** 방식이다. 이 글은 Flutter 3.38 기준으로 두 방식의 위젯을 비교하고, 어느 쪽이든 필요한 상태 모델과 접근성 대안을 정리한다.

## Draggable과 DragTarget의 구조

`Draggable<T>`는 드래그를 시작하는 쪽이고 `DragTarget<T>`는 받는 쪽이다. 두 위젯은 타입 `T`의 `data`로 연결된다.

| 위젯/속성 | 역할 |
|---|---|
| `Draggable.child` | 평소에 보이는 위젯 |
| `Draggable.feedback` | 드래그 중 손가락을 따라다니는 위젯 |
| `Draggable.childWhenDragging` | 드래그 중 원래 자리에 남는 위젯 |
| `Draggable.data` | 대상에 전달할 값 |
| `DragTarget.builder` | `(context, candidateData, rejectedData)`로 대상 모양을 그림 |
| `onWillAcceptWithDetails` | 대상 위에 올라왔을 때 받을지 판단 |
| `onAcceptWithDetails` | 놓았을 때 호출 |
| `onLeave` / `onMove` | 대상 밖으로 나가거나 안에서 움직일 때 호출 |

예전의 `onWillAccept`와 `onAccept`는 3.14 개발 버전 이후 사용 중단되었다. 새 콜백은 `DragTargetDetails<T>`를 받고, 여기서 `data`와 놓인 위치(`offset`)를 꺼낸다.

`Draggable`은 터치하자마자 드래그가 시작되고, `LongPressDraggable`은 길게 눌러야 시작된다. `LongPressDraggable`의 기본 지연은 `kLongPressTimeout`이고 시작 시 햅틱 피드백(`hapticFeedbackOnStart`)이 기본으로 켜져 있다. 단어 카드가 스크롤 영역 안에 있으면 `Draggable`은 스크롤 제스처와 경쟁한다. `affinity`를 `Axis.horizontal`로 주면 세로 움직임은 스크롤로, 가로 움직임은 드래그로 처리된다. 경쟁 자체를 피하려면 `LongPressDraggable`이 낫다.

## 상태 모델

드래그 위젯보다 먼저 상태를 정한다. 문장에는 같은 단어가 두 번 나올 수 있으므로("the cat saw the dog") 단어 문자열이 아니라 고유 id로 구분해야 한다.

```dart
@immutable
class WordTile {
  const WordTile(this.id, this.text);
  final int id;
  final String text;
}

@immutable
class OrderQuiz {
  const OrderQuiz({required this.answer, required this.bank, required this.slots});

  final List<String> answer;
  final List<WordTile> bank;
  final List<WordTile?> slots;

  bool get isFilled => slots.every((t) => t != null);
  bool get isCorrect =>
      isFilled && listEquals(slots.map((t) => t!.text).toList(), answer);

  OrderQuiz copyWith({List<WordTile>? bank, List<WordTile?>? slots}) =>
      OrderQuiz(answer: answer, bank: bank ?? this.bank, slots: slots ?? this.slots);
}
```

정답 비교는 id가 아니라 `text`로 한다. 두 개의 "the" 카드는 어느 쪽이 먼저 와도 정답이다.

```dart
class OrderQuizNotifier extends Notifier<OrderQuiz> {
  OrderQuizNotifier(this.sentence);
  final String sentence;

  @override
  OrderQuiz build() {
    final words = sentence.split(' ');
    final tiles = [for (var i = 0; i < words.length; i++) WordTile(i, words[i])]
      ..shuffle();
    return OrderQuiz(
      answer: words,
      bank: tiles,
      slots: List.filled(words.length, null),
    );
  }

  void place(WordTile tile, int index) {
    final slots = [...state.slots];
    final bank = state.bank.where((t) => t.id != tile.id).toList();

    final from = slots.indexWhere((t) => t?.id == tile.id);
    final occupant = slots[index];
    if (from != -1) {
      slots[from] = occupant;
    } else if (occupant != null) {
      bank.add(occupant);
    }
    slots[index] = tile;
    state = state.copyWith(bank: bank, slots: slots);
  }

  void placeNext(WordTile tile) {
    final empty = state.slots.indexWhere((t) => t == null);
    if (empty != -1) place(tile, empty);
  }

  void remove(int index) {
    final tile = state.slots[index];
    if (tile == null) return;
    final slots = [...state.slots]..[index] = null;
    state = state.copyWith(bank: [...state.bank, tile], slots: slots);
  }
}

final orderQuizProvider =
    NotifierProvider.family<OrderQuizNotifier, OrderQuiz, String>(
  OrderQuizNotifier.new,
);
```

`place`는 세 경우를 한 번에 처리한다. 은행에서 빈칸으로, 은행에서 차 있는 칸으로(기존 단어는 은행으로), 칸에서 칸으로(두 단어 교환). 드래그와 탭 모두 이 메서드만 호출하게 하면 입력 방식이 늘어도 규칙이 한곳에 남는다. family 인자를 생성자로 받는 형태는 Riverpod 3.0 문법이다(2.x에서는 `FamilyNotifier`의 `build(arg)`로 받는다). family 인자는 `==`로 비교되므로 `List`처럼 동일성 비교를 하는 타입 대신 문자열이나 id를 쓴다. Riverpod 자체는 [Flutter 상태 관리 비교](/2024/04/02/flutter-state-management/)에서 다뤘다.

## 빈칸과 단어 카드

```dart
class SlotView extends ConsumerWidget {
  const SlotView({super.key, required this.quizKey, required this.index});
  final String quizKey;
  final int index;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tile = ref.watch(orderQuizProvider(quizKey).select((q) => q.slots[index]));
    final notifier = ref.read(orderQuizProvider(quizKey).notifier);

    return DragTarget<WordTile>(
      onWillAcceptWithDetails: (details) => details.data.id != tile?.id,
      onAcceptWithDetails: (details) => notifier.place(details.data, index),
      builder: (context, candidates, rejected) {
        final highlighted = candidates.isNotEmpty;
        final box = SlotBox(highlighted: highlighted, child: tile == null ? null : WordChip(tile));
        if (tile == null) return box;
        return LongPressDraggable<WordTile>(
          data: tile,
          maxSimultaneousDrags: 1,
          feedback: Material(
            elevation: 6,
            borderRadius: BorderRadius.circular(12),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minWidth: 56, minHeight: 48),
              child: Center(child: WordChip(tile)),
            ),
          ),
          childWhenDragging: const SlotBox(highlighted: false),
          child: GestureDetector(onTap: () => notifier.remove(index), child: box),
        );
      },
    );
  }
}
```

몇 가지 주의점이 있다.

- `feedback`은 원래 위치가 아니라 오버레이(Overlay)에 그려진다. 부모가 주던 크기 제약과 `Material` 조상을 잃으므로 피드백 위젯 안에서 크기와 `Material`을 직접 정해 준다.
- `maxSimultaneousDrags: 1`은 멀티터치로 같은 카드를 두 번 끄는 것을 막는다. API 문서는 이때 `childWhenDragging`에 빈 위젯을 주면 실제로 옮겨지는 것처럼 보인다고 설명한다. 0을 주면 드래그 자체가 막히므로 채점 후 잠금에 쓸 수 있다.
- 빈칸의 강조는 `candidateData`가 비어 있는지로 판단한다. 거절된 데이터는 `rejectedData`에 들어온다.

## 드래그를 영역 안에 묶기

`Draggable`에는 피드백이 움직일 수 있는 영역을 정하는 옵션이 없다. 제공되는 것은 축 제한(`axis`)과 앵커 전략(`dragAnchorStrategy`, 기본값 `childDragAnchorStrategy`)뿐이다. 놓을 곳이 `DragTarget` 밖이면 `onDraggableCanceled`가 호출되고 카드는 원래 자리로 돌아가므로, 정답 판정만 보면 영역 제한이 꼭 필요하지는 않다.

카드가 화면 가장자리 밖으로 나가는 것이 문제라면 `GestureDetector`의 `onPanUpdate`로 직접 위치를 관리하고 `LayoutBuilder`가 준 크기로 좌표를 자른다.

```dart
void _onPanUpdate(DragUpdateDetails d, Size area, Size card) {
  setState(() {
    _offset = Offset(
      (_offset.dx + d.delta.dx).clamp(0.0, area.width - card.width),
      (_offset.dy + d.delta.dy).clamp(0.0, area.height - card.height),
    );
  });
}
```

이 방식은 놓기 판정도 직접 해야 한다. 각 빈칸의 `RenderBox`에서 영역을 구해 놓인 좌표와 비교하는 코드가 필요하므로, 영역 제한이 꼭 필요한 화면에만 쓴다.

## 순서 바꾸기: ReorderableListView

모든 단어가 이미 놓여 있고 순서만 바꾸는 문제라면 `ReorderableListView`가 더 단순하다.

```dart
ReorderableListView(
  scrollDirection: Axis.vertical,
  onReorder: (oldIndex, newIndex) {
    setState(() {
      if (oldIndex < newIndex) newIndex -= 1;
      final item = items.removeAt(oldIndex);
      items.insert(newIndex, item);
    });
  },
  children: [
    for (final tile in items)
      ListTile(key: ValueKey(tile.id), title: Text(tile.text)),
  ],
)
```

- 모든 항목에 키가 있어야 한다. 같은 단어가 반복되므로 id로 키를 만든다.
- `onReorder`의 `newIndex`는 항목을 빼기 전 기준이라, 뒤로 옮길 때 1을 빼야 한다.
- `buildDefaultDragHandles`가 기본 `true`이며, 모바일에서는 항목 어디든 길게 누르면 드래그가 시작되고 데스크톱에서는 끝쪽에 핸들이 생긴다.
- `proxyDecorator`로 드래그 중 항목의 그림자나 색을 바꾸고, `onReorderStart`/`onReorderEnd`로 시작과 끝에 효과음을 넣을 수 있다.

한계는 한 축으로만 늘어선다는 점이다. 문장 퀴즈처럼 여러 줄로 감기는(Wrap) 배치는 지원하지 않는다. 여러 줄 순서 바꾸기가 필요하면 `reorderables` 패키지의 `ReorderableWrap`을 쓸 수 있지만, 마지막 버전이 2023년 1월의 0.6.0이라 유지보수 상태를 감안하고 도입해야 한다. 공식 위젯만으로 여러 줄 배치를 하려면 앞의 `Draggable` + `DragTarget` 조합을 `Wrap` 안에 두는 편이 낫다.

## 드래그 없이도 풀 수 있어야 한다

드래그는 운동 기능이 불편한 사용자, 스위치 제어나 스크린 리더 사용자에게 어렵다. 두 가지 대안을 함께 둔다.

1. **탭으로 놓기**: 은행의 단어를 탭하면 첫 빈칸에 들어가고(`placeNext`), 빈칸의 단어를 탭하면 은행으로 돌아간다(`remove`). 같은 상태 메서드를 쓰므로 추가 비용이 거의 없다.
2. **커스텀 시맨틱 액션**: `CustomSemanticsAction`은 드래그 앤 드롭 같은 복잡한 상호작용을 보조 기술에서 쓸 수 있게 하는 장치로, API 문서에 따르면 Android에서는 로컬 컨텍스트 메뉴(Local Context Menu), iOS에서는 방사형 컨텍스트 메뉴(Radial Context Menu)에 나타난다.

```dart
static const _moveLeft = CustomSemanticsAction(label: '앞으로 이동');
static const _moveRight = CustomSemanticsAction(label: '뒤로 이동');

Semantics(
  label: '${index + 1}번째 칸, ${tile.text}',
  customSemanticsActions: {
    if (index > 0) _moveLeft: () => notifier.place(tile, index - 1),
    if (index < slotCount - 1) _moveRight: () => notifier.place(tile, index + 1),
  },
  child: box,
)
```

`place`가 칸끼리 교환을 처리하므로 이동 액션도 한 줄이다. 단어 카드는 탭 영역 기준(Android 48×48dp, iOS 44×44pt)을 넘도록 최소 크기를 잡는다.

## 비교

| 항목 | Draggable + DragTarget | ReorderableListView | ReorderableWrap (reorderables) |
|---|---|---|---|
| 제공 | Flutter 위젯 | Flutter 머티리얼 | 서드파티 패키지 |
| 배치 | 자유(`Wrap`, `Stack` 등) | 한 축 목록 | 여러 줄 Wrap |
| 은행 → 빈칸 이동 | 가능 | 불가(목록 안 순서만) | 불가(목록 안 순서만) |
| 드롭 판정 | 대상별 `onWillAcceptWithDetails` | 위치로 자동 계산 | 위치로 자동 계산 |
| 자리 비켜 주기 애니메이션 | 직접 구현 | 기본 제공 | 기본 제공 |
| 키 요구 | 없음 | 모든 항목에 필수 | 패키지 규칙 따름 |
| 유지보수 | SDK와 함께 | SDK와 함께 | 2023년 이후 릴리스 없음 |

## 정리

1. 은행에서 빈칸으로 옮기는 문제는 `Draggable`/`LongPressDraggable` + `DragTarget`, 놓인 목록의 순서만 바꾸는 문제는 `ReorderableListView`가 맞다.
2. `DragTarget`은 `onWillAcceptWithDetails`/`onAcceptWithDetails`를 쓴다. `onWillAccept`/`onAccept`는 사용 중단되었다.
3. 반복 단어를 위해 카드는 id로 구분하고, 정답 비교는 텍스트로 한다.
4. 배치 규칙은 `place` 하나에 모으고 드래그, 탭, 시맨틱 액션이 모두 같은 메서드를 호출하게 한다.
5. 피드백은 오버레이에 그려지므로 크기와 `Material`을 직접 지정하고, 영역 제한이 필요하면 제스처를 직접 처리한다.
6. `ReorderableListView`는 `newIndex` 보정과 항목 키를 잊지 않는다.
7. 드래그만으로 풀 수 있는 문제는 접근성 결함이다. 탭으로 놓기와 커스텀 시맨틱 액션을 함께 둔다.
