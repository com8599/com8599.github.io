---
layout: post
title: 목록 주소가 상세까지 먹었다
date: 2021-11-23
tags: [react]
description: React Router 5에서 /orders는 exact가 없으면 /orders/3도 목록이다.
---

상세로 들어갔는데 목록이 나왔다. 주소는 `/orders/3`이 맞았다. Route는 두 개였다. 하나는 `/orders`, 하나는 `/orders/:id`.

Router 5의 `Switch`는 먼저 맞는 것을 그리고 멈춘다. `/orders`는 뒤에 뭐가 더 있어도 맞는다. `/orders/3`도 `/orders`다. exact가 없으니 상세 Route까지 내려가지 않았다. 목록 Route에 `exact`를 붙이니 `/orders`만 목록이 되고, 그 아래 id가 있는 주소는 상세로 갔다.

v6부터는 이 기본이 바뀌어서, 그때 쓰던 예제를 그대로 옮기면 또 달라진다. 2021년에 보고 있던 건 v5였다.
