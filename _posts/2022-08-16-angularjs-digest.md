---
layout: post
title: AngularJS digest 사이클과 $apply
date: 2022-08-16
tags: [angular]
description: AngularJS가 변경을 감지하는 방식과, 외부 콜백에서 값을 바꿀 때 화면이 갱신되지 않는 이유.
---

AngularJS(1.x)는 값이 바뀌는 순간을 알지 못한다. 대신 특정 시점에 등록된 모든 감시 대상(watcher)을 다시 비교하는 **더티 체킹(dirty checking)** 방식으로 변경을 찾는다. 이 비교 과정이 digest 사이클(digest cycle)이다.

## 동작 방식

1. 템플릿 바인딩(`ng-bind`, `ng-model`, `ng-if` 등)은 각각 `$watch`를 등록한다.
2. `$digest()`가 실행되면 모든 watcher의 현재 값을 이전 값과 비교한다.
3. 하나라도 바뀌면 리스너를 실행하고, 다시 처음부터 비교한다.
4. 바뀐 것이 없을 때까지 반복한다. 반복이 10회(`$rootScopeProvider.digestTtl` 기본값)에 도달해도 안정되지 않으면 `$rootScope:infdig`(`10 $digest() iterations reached. Aborting!`) 에러로 중단한다.

## 누가 digest를 시작하는가

AngularJS가 제공하는 경로는 작업이 끝나면 자동으로 digest를 실행한다.

- `ng-click`, `ng-change` 등 디렉티브(directive) 이벤트
- `$http`, `$timeout`, `$interval`, `$q`

다음 경로에서는 실행되지 않는다.

- `setTimeout`, `setInterval`
- `addEventListener`로 직접 붙인 이벤트
- 서드파티 SDK 콜백, WebSocket 메시지, 네이티브 브리지 콜백

이 경로에서 `$scope` 값을 바꾸면 값은 바뀌지만 화면은 다음 digest가 일어날 때까지 그대로다.

## $apply

```js
sdk.onComplete(function (result) {
  $scope.$apply(function () {
    $scope.status = result.status;
  });
});
```

`$apply(fn)`은 `fn`을 실행한 뒤 `$rootScope.$digest()`를 호출한다. 함수 안에서 발생한 예외도 AngularJS의 `$exceptionHandler`로 전달된다.

이미 digest나 `$apply`가 진행 중일 때 `$apply`를 호출하면 `$rootScope:inprog`(`$digest already in progress` 또는 `$apply already in progress`) 에러가 난다. 같은 함수가 AngularJS 안팎에서 모두 불릴 수 있다면 다음을 쓴다.

| API | 동작 |
|---|---|
| `$timeout(fn)` | 다음 틱에 `$apply`로 감싸 실행(`invokeApply` 기본값 `true`) |
| `$scope.$evalAsync(fn)` | 진행 중인 digest 안에서 실행, 진행 중인 digest가 없으면 새 digest를 예약 |
| `$scope.$applyAsync(fn)` | `$apply`를 약간 뒤(보통 약 10ms)로 미뤄, 그 사이의 여러 호출을 한 번의 digest로 처리 |

## 성능

digest 비용은 watcher 수에 비례한다. 화면에 watcher가 수천 개가 되면 입력마다 지연이 생긴다.

- 바뀌지 않는 값은 one-time binding(`ng-bind="::user.name"`)으로 값이 `undefined`가 아닌 값으로 안정되면 watcher를 해제한다.
- `ng-repeat`은 기본적으로 객체 자체(`$id`, `$$hashKey`)로 항목을 추적하므로 데이터를 다시 불러와 객체가 새로 만들어지면 DOM을 다시 만든다. `track by item.id`처럼 고유 식별자로 추적하면 기존 DOM 요소를 재사용한다.
- 깊은 비교(deep watch, `$watch(expr, fn, true)`)는 `angular.copy`로 객체 전체를 복사해 두고 `angular.equals`로 비교하므로 최소화한다.

## Angular(2+)와의 차이

Angular는 zone.js가 `setTimeout`, 이벤트, Promise 등 비동기 API를 몽키 패치(monkey patching)해 작업이 끝날 때 변경 감지(change detection)를 자동 실행한다. AngularJS에서 수동으로 `$apply`가 필요했던 상황 대부분이 자동으로 처리된다. 다만 Angular zone 밖에서 실행되는 콜백(예: `NgZone.runOutsideAngular`로 등록했거나 zone.js가 패치하지 못하는 서드파티 콜백)에서 상태를 바꿀 때는 `NgZone.run()`으로 다시 zone 안으로 들여와야 한다.
