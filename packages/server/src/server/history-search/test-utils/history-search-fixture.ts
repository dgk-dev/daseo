/**
 * Synthetic History search corpus. The topics and query shapes mirror the
 * 26 queries measured on the owner's real history on 2026-11-04 (18 topics,
 * each with a short and a recalled-sentence query, 8 with a paraphrase that
 * shares no word with the session), but every line here is written for the
 * test. Real transcripts never enter the repository.
 *
 * Titles are deliberately generic so that a match can only come from what was
 * said in the session.
 */

export interface FixtureMessage {
  role: "user" | "assistant";
  text: string;
}

export interface FixtureSession {
  id: string;
  title: string;
  messages: FixtureMessage[];
}

export interface FixtureQuery {
  target: string;
  short: string;
  long: string;
  /** Shares no word with the target session; only meaning can find it. */
  paraphrase?: string;
}

export const HISTORY_FIXTURE_SESSIONS: FixtureSession[] = [
  {
    id: "daycare",
    title: "작업 01",
    messages: [
      {
        role: "user",
        text: "로운이 내년 3월에 0세반 어린이집 보내야 하는데 신청 순서가 어떻게 돼?",
      },
      {
        role: "assistant",
        text: "국공립 어린이집은 입소 신청일 순서와 순위 점수로 정해집니다. 3순위라면 신청일이 빠를수록 유리하고, 최대 세 곳까지 넣을 수 있습니다.",
      },
      { role: "user", text: "그럼 으뜸이랑 대조 두 곳 먼저 넣자" },
    ],
  },
  {
    id: "worship-key",
    title: "작업 02",
    messages: [
      {
        role: "user",
        text: "주일 예배 찬양 세 곡인데 기타로 칠 수 있게 키 바꾼 악보 만들어줘. F는 못 잡아서 카포로 해결하고 싶어",
      },
      {
        role: "assistant",
        text: "오직 주만이는 E 모양에 카포 1로, 나의 안에 거하라는 E 그대로 두겠습니다. 코드 글자만 지우고 새로 쓴 악보를 보내드릴게요.",
      },
    ],
  },
  {
    id: "railway-incident",
    title: "작업 03",
    messages: [
      { role: "user", text: "railway 토큰이 유출됐대. 보안 사고 대응 순서 정리해줘" },
      {
        role: "assistant",
        text: "Railway 프로젝트 토큰을 먼저 폐기하고, 배포 환경변수에 있던 키를 전부 교체한 뒤 접근 로그를 확인하겠습니다. Phase A는 키 교체, Phase B는 외부 서비스 키 재발급입니다.",
      },
    ],
  },
  {
    id: "search-credits",
    title: "작업 04",
    messages: [
      { role: "user", text: "리서치 돌릴 때마다 검색 크레딧이 너무 빨리 닳는데 원인 좀 찾아줘" },
      {
        role: "assistant",
        text: "질의의 87%가 리서치 워커에서 나왔고, 같은 질의가 두 공급사에 이중 청구되고 있었습니다. 기본 경로를 Perplexity 중심으로 바꾸면 크레딧 소모가 절반 이하로 줄어듭니다.",
      },
    ],
  },
  {
    id: "api-credit-pooling",
    title: "작업 05",
    messages: [
      {
        role: "user",
        text: "클로드 맥스 계정마다 매달 주는 api 크레딧을 한 곳에 모아서 쓰는 방법 없을까",
      },
      {
        role: "assistant",
        text: "계정마다 발급되는 월간 API 크레딧을 게이트웨이 하나로 묶어 순서대로 소진하게 만들 수 있습니다. 키 다섯 개를 등록하고 남은 잔액 순으로 라우팅합니다.",
      },
    ],
  },
  {
    id: "secrets-1password",
    title: "작업 06",
    messages: [
      {
        role: "user",
        text: "API 키 유출 이후로 비밀값을 1Password로 옮기자. 시트에 평문으로 있는 것도 다",
      },
      {
        role: "assistant",
        text: "FC_IDPW 시트의 로그인 935개와 금융 134개를 금고로 옮기고, 환경변수는 앱마다 항목 하나로 묶어 op:// 참조로 바꾸겠습니다.",
      },
    ],
  },
  {
    id: "passkey",
    title: "작업 07",
    messages: [
      { role: "user", text: "다세오 브라우저에서 ChatGPT 로그인할 때 패스키 창이 안 떠" },
      {
        role: "assistant",
        text: "Electron에는 플랫폼 인증기가 없어서 navigator.credentials.get()이 응답 없이 멈춥니다. 탭마다 가상 인증기를 붙여 패스키를 저장하고 다시 쓰게 하겠습니다.",
      },
    ],
  },
  {
    id: "parsec-titlebar",
    title: "작업 08",
    messages: [
      {
        role: "user",
        text: "씽크패드에서 parsec 창 위에 제목줄 좀 없애줘. 위쪽이 한 줄 가려져",
      },
      {
        role: "assistant",
        text: "Parsec 창의 제목줄을 자동으로 제거하는 보조 프로그램을 설치하고, Alt+Tab으로 두 Parsec 창을 오가게 했습니다.",
      },
    ],
  },
  {
    id: "approval-slack",
    title: "작업 09",
    messages: [
      {
        role: "user",
        text: "결재 의견에 사람 이름을 태그하면 그 사람한테 슬랙 알림이 가게 해줘",
      },
      {
        role: "assistant",
        text: "결재 의견 입력창에서 @이름을 태그로 인식하고, 저장할 때 태그된 직원에게 슬랙 DM을 보내도록 연결했습니다.",
      },
    ],
  },
  {
    id: "luke-theology",
    title: "작업 10",
    messages: [
      { role: "user", text: "누가 신학 과제 정리 좀 도와줘. 누가복음의 성령 이해 중심으로" },
      {
        role: "assistant",
        text: "누가복음과 사도행전을 한 저자의 두 권으로 보고, 성령이 예수의 사역과 교회의 선교를 잇는 구조로 과제를 정리했습니다.",
      },
    ],
  },
  {
    id: "loan-plan",
    title: "작업 11",
    messages: [
      { role: "user", text: "대출 받아서 마이너스 통장 갚는 게 이자 면에서 나을까?" },
      {
        role: "assistant",
        text: "마이너스 통장 금리가 신용대출보다 1.8%p 높아서, 대출로 갈아타면 연간 이자가 줄어듭니다. 중도상환 수수료를 먼저 확인하세요.",
      },
    ],
  },
  {
    id: "jeonse",
    title: "작업 12",
    messages: [
      { role: "user", text: "전세 집 구할 때 등기부에서 뭘 봐야 해?" },
      {
        role: "assistant",
        text: "전세 계약 전에는 등기부등본의 근저당과 선순위 권리를 보고, 보증보험 가입이 되는지 확인해야 합니다.",
      },
    ],
  },
  {
    id: "alert-cleanup",
    title: "작업 13",
    messages: [
      { role: "user", text: "ax 채널에 봇 알림이 너무 많이 와. 알림 정리 좀 하자" },
      {
        role: "assistant",
        text: "같은 장애가 반복될 때 10분 유예 후 한 번만 보내고, 복구 알림은 묶어서 보내도록 줄였습니다.",
      },
    ],
  },
  {
    id: "incentive-thanks",
    title: "작업 14",
    messages: [
      { role: "user", text: "인센티브 받아서 이사님께 감사 인사 문구 써줘. 짧고 담백하게" },
      {
        role: "assistant",
        text: "이사님, 이번 인센티브 정말 감사합니다. 맡겨주신 일에 더 책임감 있게 임하겠습니다.",
      },
    ],
  },
  {
    id: "new-hire-email",
    title: "작업 15",
    messages: [
      { role: "user", text: "신규 입사자가 회사 메일 대신 개인 이메일을 쓰고 있어. 어떻게 막지?" },
      {
        role: "assistant",
        text: "입사 첫날 계정 발급 체크리스트에 회사 메일 로그인 확인을 넣고, 외부 주소로 보내는 공유를 막는 정책을 켜겠습니다.",
      },
    ],
  },
  {
    id: "gospel-order",
    title: "작업 16",
    messages: [
      { role: "user", text: "복음서 중에 뭐가 먼저 쓰였는지, Q자료가 뭔지 설명해줘" },
      {
        role: "assistant",
        text: "마가복음이 먼저 쓰였다는 마가 우선설이 다수설이고, 마태와 누가가 공통으로 쓴 말씀 자료를 Q자료라고 부릅니다.",
      },
    ],
  },
  {
    id: "cafe24-seo",
    title: "작업 17",
    messages: [
      { role: "user", text: "카페24 쇼핑몰들 seo 개선 좀 해줘. 상품 페이지 메타 태그부터" },
      {
        role: "assistant",
        text: "상품 상세의 title과 meta description을 상품명 기준으로 채우고, 사이트맵과 구조화 데이터를 추가했습니다.",
      },
    ],
  },
  {
    id: "php-vulnerability",
    title: "작업 18",
    messages: [
      {
        role: "user",
        text: "php 취약점 기사가 나왔는데 우리 회사 사이트 해킹 안전한지 봐줘",
      },
      {
        role: "assistant",
        text: "사이트가 쓰는 PHP 버전이 해당 CVE 영향 범위 밖이고, 업로드 경로의 실행 권한도 꺼져 있어 안전합니다.",
      },
    ],
  },
  // Distractors: plausible sessions that none of the queries are about.
  {
    id: "distractor-terminal",
    title: "Terminal resize fix",
    messages: [
      { role: "user", text: "The terminal pane flickers when I resize the window." },
      {
        role: "assistant",
        text: "The resize observer fired twice per frame; coalescing it fixed the flicker.",
      },
    ],
  },
  {
    id: "distractor-invoice",
    title: "작업 20",
    messages: [
      { role: "user", text: "세금계산서 자동 발행 규칙 정리해줘" },
      {
        role: "assistant",
        text: "매월 말일 마감 후 거래처별로 묶어서 다음 달 10일까지 발행하는 규칙으로 정리했습니다.",
      },
    ],
  },
  {
    id: "distractor-deploy",
    title: "작업 21",
    messages: [
      { role: "user", text: "vercel 배포가 빌드 슬롯 대기에서 오래 걸려" },
      {
        role: "assistant",
        text: "동시에 빌드되는 앱이 일곱 개라 슬롯을 기다립니다. 바뀐 앱만 빌드하도록 무시 규칙을 넣었습니다.",
      },
    ],
  },
];

export const HISTORY_FIXTURE_QUERIES: FixtureQuery[] = [
  {
    target: "daycare",
    short: "어린이집",
    long: "아이 어린이집 보내는 문제 얘기했던 거",
    paraphrase: "애기 보육시설 대기 순번",
  },
  { target: "worship-key", short: "찬양 키", long: "예배 찬양 기타로 칠 수 있게 키 바꾼 악보" },
  {
    target: "railway-incident",
    short: "railway 보안",
    long: "레일웨이 보안 사고 나서 키 교체 대응했던 거",
  },
  {
    target: "search-credits",
    short: "검색 크레딧",
    long: "리서치할 때 검색 크레딧이 너무 빨리 닳던 원인",
    paraphrase: "인터넷 조회 요금이 치솟음",
  },
  {
    target: "api-credit-pooling",
    short: "api 크레딧",
    long: "클로드 맥스 계정마다 주는 API 크레딧 모아서 쓰는 방법",
  },
  {
    target: "secrets-1password",
    short: "1password",
    long: "API 키 털려서 1Password로 비밀 관리 옮긴 작업",
    paraphrase: "비밀번호 관리 도구로 옮겨 담기",
  },
  {
    target: "passkey",
    short: "패스키",
    long: "다세오 브라우저에서 로그인할 때 패스키 안 되던 문제",
  },
  {
    target: "parsec-titlebar",
    short: "parsec 제목줄",
    long: "씽크패드 원격 접속 창 위에 제목줄 없애기",
    paraphrase: "원격 데스크톱 노트북 화면 테두리 숨기기",
  },
  {
    target: "approval-slack",
    short: "결재 태그 슬랙",
    long: "결재 의견에 사람 이름 태그하면 슬랙으로 알림 가게",
  },
  { target: "luke-theology", short: "누가 신학", long: "누가복음 신학 과제 정리" },
  {
    target: "loan-plan",
    short: "대출",
    long: "대출 받아서 마이너스 통장 갚는 계획",
    paraphrase: "돈 빌려서 빚 정리",
  },
  { target: "jeonse", short: "전세", long: "전세 집 구하던 대화" },
  { target: "alert-cleanup", short: "알림 정리", long: "ax 채널에 봇 알림 너무 많이 와서 줄인 거" },
  {
    target: "incentive-thanks",
    short: "인센티브 감사",
    long: "인센티브 받아서 이사님께 감사 인사 문구 쓴 거",
  },
  { target: "new-hire-email", short: "입사자 이메일", long: "신규 입사자가 개인 이메일 쓰는 문제" },
  {
    target: "gospel-order",
    short: "복음서 순서",
    long: "복음서 중에 뭐가 먼저 쓰였는지 Q자료",
    paraphrase: "공관복음 저작 시기",
  },
  {
    target: "cafe24-seo",
    short: "seo 카페24",
    long: "카페24 쇼핑몰들 검색엔진 최적화 개선",
    paraphrase: "온라인몰 검색 노출 높이기",
  },
  {
    target: "php-vulnerability",
    short: "php 취약점",
    long: "php 취약점 때문에 우리 회사 사이트 해킹 안전한지",
    paraphrase: "웹 서버 보안 구멍 점검",
  },
];
