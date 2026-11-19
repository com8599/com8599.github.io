---
layout: post
title: 빌드하니 주소가 undefined
date: 2021-10-06
tags: [react]
description: Create React App은 REACT_APP_으로 시작하는 변수만 넣는다.
---

로컬 `npm start`에서는 API 주소가 맞았다. `npm run build`로 만든 파일을 올려 보니 요청이 `undefined/api/orders`로 갔다.

`.env`에 `API_URL`이라고 적어 두고 `process.env.API_URL`로 읽고 있었다. Create React App은 `REACT_APP_`으로 시작하는 것만 빌드에 넣는다. 나머진 클라이언트 코드에서 `undefined`다. 개발 서버를 다시 켜도, 그 이름은 처음부터 안 들어온다. 접두사를 붙이고 나서야 값이 보였다.

그것도 빌드하는 순간에 박힌다. 서버에 올라간 다음 `.env`를 고쳐도 이미 만들어진 js는 안 바뀐다. 주소를 바꾸면 다시 빌드해야 했다.
