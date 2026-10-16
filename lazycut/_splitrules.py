"""Korean subtitle line splitting rules (from research/split_lines_proto.py, tuned on real talking-head recordings)."""
from __future__ import annotations
import math
import re

__all__ = ["split_lines", "lines_from_starts", "detect_bad_breaks", "break_analysis", "caption_text",
           "make_cues", "line_text", "estimate_pauses", "DEFAULT_PARAMS"]

# --------------------------------------------------------------------------
# Hangul helpers
# --------------------------------------------------------------------------
_HB, _HE = 0xAC00, 0xD7A3
_JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"


def _is_hangul(ch):
    return bool(ch) and _HB <= ord(ch) <= _HE


def _jong(ch):
    """final consonant index (0 = none, 4 = ㄴ, 8 = ㄹ, 20 = ㅆ ...), -1 if not Hangul."""
    if not _is_hangul(ch):
        return -1
    return (ord(ch) - _HB) % 28


def _jung(ch):
    if not _is_hangul(ch):
        return ""
    return _JUNG[((ord(ch) - _HB) // 28) % 21]


_QUOTES = "\"'“”‘’「」『』()[]<>《》"
_TRAIL_PUNCT = ".,?!…~;:·"


def _core(text):
    """token without surrounding quotes/brackets and trailing punctuation."""
    t = text.strip().strip(_QUOTES)
    t = t.rstrip(_TRAIL_PUNCT).strip(_QUOTES)
    return t


def line_text(ws):
    return " ".join(w["text"].strip() for w in ws if w["text"].strip())


def _wlen(text):
    return len(text.strip())


# --------------------------------------------------------------------------
# Lexicons (small, hand-written; extend freely)
# --------------------------------------------------------------------------
SENT_ADVERBS = {  # good to START a line, bad to END a line with
    "그래서", "그리고", "근데", "그런데", "하지만", "그러나", "그러면", "그럼", "그러니까", "그니까",
    "그래도", "그러다", "그러다가", "그랬더니", "또", "또한", "결국", "결국엔", "결국은", "사실", "사실은",
    "일단", "우선", "이제", "자", "왜냐하면", "왜냐면", "물론", "특히", "즉", "다만", "오히려", "아무튼",
    "어쨌든", "따라서", "그래가지고", "첫째", "둘째", "셋째", "넷째", "첫번째", "두번째", "마지막으로",
    "반면", "반면에", "게다가", "심지어", "참고로", "혹시", "만약", "만약에", "예를", "솔직히",
}
TIME_WORDS = {  # time / frame adverbials: good to start a line, neutral to end one
    "요즘", "요새", "오늘", "오늘은", "오늘만큼은", "지금", "지금은", "최근", "최근에", "최근엔", "이번에는",
    "이번엔", "원래", "앞으로", "올해", "올해는", "내년", "내년엔", "내년에는", "작년", "작년에", "예전에",
    "이전에", "당시", "당시에", "나중에", "처음엔", "처음에는", "요즘은", "그때", "그때는", "평소에",
    "기존에", "현재", "현재는", "아직은", "앞서",
}
DETERMINERS = {  # prenominal words: never end a line with them
    "그", "이", "저", "이런", "그런", "저런", "어떤", "무슨", "모든", "각", "여러", "다른", "새", "온갖",
    "첫", "매", "몇", "한", "두", "세", "다섯", "여섯", "일곱", "여덟", "아홉", "스무", "약", "총",
    "내", "제", "네", "저희", "우리", "이번", "지난", "다음", "어느", "웬", "아무", "별", "단", "각각",
}
NEG_ADVERBS = {"안", "못"}
FRAME_ADVERBS = {  # sentence-level adverbs: weakly attached, break after is acceptable
    "본격적으로", "궁극적으로", "실제로", "물리적으로", "개인적으로", "적극적으로", "기본적으로", "전반적으로",
    "솔직히", "확실히", "아마", "아마도", "물론", "역시", "예를들어", "예컨대",
}
CLAUSE_NOUNS = {"때", "것", "동안", "뒤", "후", "전", "중", "다음", "이후", "이전", "경우", "대신", "만큼", "덕분에",
                "때문에", "듯", "듯이"}
PREVERBAL_ADVERBS = {  # adverbs that attach to the following predicate
    "잘", "더", "덜", "다", "좀", "꼭", "확", "딱", "쭉", "막", "너무", "아주", "매우", "정말", "진짜",
    "되게", "굉장히", "많이", "같이", "함께", "먼저", "바로", "가장", "제일", "다시", "계속", "이미",
    "벌써", "그냥", "거의", "훨씬", "직접", "빨리", "열심히", "스스로", "혼자", "서로", "제대로", "미리",
    "이렇게", "그렇게", "저렇게", "어떻게", "왜", "얼마나", "전혀", "절대", "단순히", "자세히", "똑같이",
    "통째로", "별도로", "끝까지", "알아서", "조금", "자꾸", "늘", "늘상", "항상", "자주", "가끔", "당장",
    "확실히", "충분히", "완전히", "그대로", "따로", "새로", "쉽게", "크게", "작게", "빠르게", "천천히",
    "처음으로", "이렇게까지",
    "제일", "엄청", "되게", "참", "꽤", "상당히", "특별히", "대충", "살짝", "모두", "전부", "하나하나",
}
BOUND_NOUNS = {  # dependent nouns: must stay with the preceding modifier
    "수", "거", "것", "게", "걸", "건", "때", "줄", "데", "뿐", "만큼", "듯", "적", "바", "리", "채", "대로",
    "지", "분", "분들", "측", "편", "쪽", "김", "겸", "덕분", "탓", "중", "동안", "정도", "만", "척", "체",
    "나름", "따름", "터", "참", "법", "모양", "셈", "뻔", "즈음", "무렵",
}
# surface forms (bound noun + particle / copula) that are NOT bound nouns
BOUND_FALSE = {"거의", "거기", "거기서", "거기에", "거꾸로", "것들", "게다가", "건강", "걸음", "데이터",
               "때로", "때로는", "줄곧", "적어도", "적극적으로", "편하게", "쪽지", "중요", "중요한", "중요하지만",
               "중요해지지", "중요해진다고", "중국", "중순에는", "중간", "정도로", "만약", "만약에", "만들",
               "만들고", "만든", "만드는", "만들어서", "만들지", "만들어놨더라고요", "만드세요라고", "만에",
               "분석", "분야", "분위기", "법인으로", "수많은", "수준", "지금", "지금은", "지원하고", "지켜봤을",
               "리더", "리더가", "리더급까지", "리더님과", "리더분도", "리더와", "터치", "체계", "체계,",
               "바로", "바탕으로", "바뀌면", "적이", "데리고", "데모", "만큼은", "동안에", "줄고", "줄이기도",
               "줄어들었고요", "줄어든", "줄이", "지난", "지나", "편이", "수록", "분석", "분야"}
BOUND_PARTICLE_TAILS = ("", "이", "가", "은", "는", "을", "를", "도", "만", "에", "에는", "으로", "로",
                        "이에요", "예요", "이죠", "죠", "이고", "고", "이라", "라", "이라고", "라고", "야",
                        "이야", "입니다", "니까", "인데", "처럼", "까지", "부터", "들", "들은", "들이", "들을",
                        "들한테", "들께", "한테", "께", "이나", "나", "든", "요", "만큼", "이다", "다")
COUNTERS = ("개월", "개", "명", "분", "년", "월", "일", "시간", "시", "번째", "번", "살", "원", "가지", "배",
            "퍼센트", "%", "차", "주", "달", "장", "권", "등", "층", "초", "회", "건", "곳", "칸",
            "단계", "만", "억", "천", "백", "십", "점", "줄", "박")
KOR_NUMS = {"한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉", "열", "스무", "하나", "둘", "셋",
            "넷", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구", "십", "백", "천", "만", "몇", "수십",
            "수백", "수천", "첫", "삼십", "이십", "사십", "오십", "백만"}
PARTICLE_WORDS = {"은", "는", "을", "를", "의", "에", "에서", "으로", "와", "과", "이다", "입니다", "이에요",
                  "예요", "이예요", "이야", "라고", "이라고", "처럼", "까지", "부터", "한테", "에게", "께서",
                  "이랑", "랑", "만큼", "보다", "에게서", "이나", "이죠", "이고", "이라"}
AUX_PREFIXES = {  # aux verbs that follow -아/-어 forms
    "a": ("보", "봐", "봤", "볼", "본", "주", "줘", "줬", "줄", "준", "드리", "드릴", "드려", "드렸",
          "버리", "버려", "버렸", "버린", "놓", "놔", "놨", "두", "둬", "뒀", "내", "냈", "낼", "가", "갔",
          "갈", "간", "오", "왔", "올", "온", "있", "계시", "계세", "대", "지", "져", "졌", "치우", "먹"),
    "go": ("있", "싶", "계시", "계세", "나", "말", "보니", "보면"),   # after -고
    "ji": ("않", "못", "말", "마"),                                  # after -지
    "ya": ("하", "해", "했", "할", "합", "되", "돼", "됐", "될", "됩", "한다"),  # after -야
    "ge": ("하", "해", "했", "할", "합", "되", "돼", "됐", "될", "됩", "만들", "만드", "만든"),  # after -게
    "gi": ("하", "해", "했", "할", "합", "되", "돼", "됐"),             # after -기도/-기는/-기로
    "myeon": ("되", "돼", "됩", "된다", "좋", "안"),                   # -면 되다
}
QUOTE_VERBS = ("하", "했", "합", "해", "할", "말", "생각", "얘기", "들", "물어", "물었", "부르", "불러", "적",
               "써", "쓰", "느껴", "느낀", "보", "봐", "봤", "알", "믿", "답", "얘길")
FINAL_ENDINGS = ("습니다", "니다", "어요", "아요", "에요", "예요", "해요", "세요", "네요", "거든요", "는데요",
                 "고요", "죠", "지요", "래요", "대요", "까요", "게요", "군요", "나요", "더라고요", "잖아요",
                 "요", "다", "까", "냐", "니", "네", "지", "야", "어", "자")
CONN_ENDINGS = (  # clause-level connective endings (good break after)
    "는데", "은데", "인데", "한데", "던데", "지만", "니까", "으니", "면서", "으면서", "으며", "며", "고서",
    "도록", "려고", "으려고", "러", "다가", "어도", "아도", "해도", "여도", "워도", "라도", "자마자", "듯이",
    "는지", "은지", "을지", "ㄹ지", "기에", "어야", "아야", "해야", "워야", "러야", "더니", "보니", "보니까",
    "는데도", "다며", "라며", "거나", "든지", "든가", "게끔", "길래", "느라", "느라고", "다면", "라면",
    "으면", "면", "고", "서", "니", "라", "야", "는데,", "지", "든", "니만큼", "므로", "으므로", "는지라",
    "다시피", "자", "건", "거든", "면은",
)
QUOT_ENDINGS = ("다고", "라고", "냐고", "자고", "다라고", "라고도", "다고도", "냐라고", "다라는", "라는",
                "다는", "냐는", "자는")
NOUN_SEO = {"제안서", "견적서", "보고서", "계약서", "신청서", "설명서", "지원서", "이력서", "자소서", "증명서",
            "안내서", "기획서", "청구서", "교과서", "순서", "도서", "문서", "서", "영수증서", "각서"}
NOUN_MYEON = {"측면", "화면", "방면", "이면", "반면", "전면", "표면", "국면", "장면", "면", "라면", "평면"}
NOUN_RA = {"카메라", "인프라", "울트라", "드라", "라", "오페라", "코브라", "산타클라라", "브라"}
NOUN_GO = {"광고", "창고", "참고", "최고", "재고", "원고", "사고", "고", "신고", "경고", "학교"}
NOUN_NI = {"어머니", "할머니", "유니", "테크니", "미니", "니", "주머니", "언니", "바구니", "이니"}
NOUN_YA = {"분야", "야", "시야", "광야", "이야"}
NOUN_JI = {"이미지", "페이지", "메시지", "지", "의지", "자기", "포지", "에너지", "지지", "여지", "바지",
           "종이지", "가치", "관리", "회의", "가지", "한가지"}
TOPIC_NOUN_NEUN = {"우리는", "회사는", "정보는", "얘기는", "이야기는", "경우는", "국가는", "평가는", "의사는",
                   "저는", "나는", "너는", "이거는", "그거는", "저거는", "저희는", "주제는", "기사는", "가치는",
                   "교사는", "영상는", "이유는", "자료는", "비용는", "오늘은", "지금은", "미래는", "시대는",
                   "회의는", "거는", "건", "이건", "그건", "제가", "때는", "부분은", "기준은", "목표는", "요지는"}
NEUN_VERB_SYLL = set("하되있없드가오보주받쓰내지치키리르우추시않라다파사아노여거먹듣찾맞갖잡묻읽웃넣놓낳붙돕쉬끄띄뛰꾸누부는려"
                     "켜열얻잃견겪살알날놀졸울풀걸쓸끌밀팔")
EUN_ADJ_SYLL = set("많좋같싶작높낮넓깊받맡남늦젊찮않먹읽찾놓넣얻잃짧옳밝맑적있없했됐왔갔봤줬났썼컸였였셨")
ADN_NOUN_EXCEPT = {  # nouns ending in ㄴ/ㄹ syllables that look like adnominal forms
    "시간", "인간", "기간", "공간", "순간", "중간", "년간", "기본", "일본", "자본", "원본", "대본", "최종본",
    "견본", "사본", "근본", "표본", "안", "반", "간", "진단", "사진", "자신", "당신", "혁신", "신",
    "인", "원인", "개인", "직원", "회원", "지원", "인원", "확인", "승인", "법인", "성인", "직장인", "외국인",
    "기술인", "전", "선", "운", "문", "만", "판", "단", "산", "연간", "주간", "월간", "야간", "민간",
    "일", "말", "날", "달", "길", "물", "불", "술", "글", "풀", "레벨", "모델", "호텔", "스타일", "파일",
    "메일", "룰", "툴", "골", "콜", "롤", "셀", "어필", "프로필", "레일", "디테일", "샘플", "심플", "타이틀",
    "모바일", "스케일", "서울", "얼굴", "가을", "겨울", "마을", "시골", "사실", "현실", "진실", "회의실",
    "교실", "실", "들", "를", "을", "줄", "분", "스킬", "토큰", "설명란", "보상", "정신", "자연", "환경", "선진", "엔진", "맨",
    "팀원", "멘토링", "캔", "선생", "멤버", "강의실", "연구실", "만", "천", "억", "번", "편", "권", "명",
    "변신", "통신", "소신", "확신", "자신감", "답변", "주인", "결론", "토론", "이론", "여론", "언론", "의견",
    "오픈", "플랜", "디자인", "온라인", "오프라인", "라인", "가이드라인", "시즌", "비전", "버전", "미션",
    "패턴", "포인트", "커리큘럼", "프로그램", "매트릭스", "중순", "상순", "하순", "학원", "대학원", "병원",
    "공원", "연구원", "사원", "신입사원", "대표님", "운동", "연봉", "보통", "석박사", "범용",
}
ENUMERATORS = {"하나", "둘", "셋", "넷", "다섯", "첫째", "둘째", "셋째", "넷째", "첫번째", "두번째", "세번째",
               "1", "2", "3", "4", "5"}
SHORT_OK_LINES = {"네", "자", "자,", "감사합니다", "안녕하세요", "그래서", "그런데", "근데", "아니요", "맞아요",
                  "좋습니다", "여러분"}


# --------------------------------------------------------------------------
# Token classification
# --------------------------------------------------------------------------
def _ends_any(s, suffixes):
    for suf in suffixes:
        if suf and s.endswith(suf):
            return suf
    return None


def _is_number(core):
    if not core:
        return False
    if re.fullmatch(r"[0-9][0-9,\.]*", core):
        return True
    return core in KOR_NUMS


def _starts_with_counter(core):
    for c in COUNTERS:
        if core.startswith(c):
            return c
    return None


def _bound_noun(core):
    """True if the token is a dependent noun (+ optional particle)."""
    if not core or core in BOUND_FALSE:
        return False
    for b in sorted(BOUND_NOUNS, key=len, reverse=True):
        if core.startswith(b):
            tail = core[len(b):]
            if tail in BOUND_PARTICLE_TAILS:
                return True
    return False


def _is_adnominal(core):
    """Heuristic: does this eojeol end with an adnominal (관형형) ending -는/-(으)ㄴ/-(으)ㄹ/-던?"""
    if len(core) == 0 or not _is_hangul(core[-1]):
        return False
    if core in ADN_NOUN_EXCEPT or core in TOPIC_NOUN_NEUN:
        return False
    last = core[-1]
    prev = core[-2] if len(core) >= 2 else ""
    if core.endswith(("라는", "다는", "냐는", "자는", "이라는", "적인", "같은", "던", "하는", "되는", "있는",
                      "없는", "않는", "않은", "있던", "없던", "했던", "됐던", "였던", "이신", "하신", "하실",
                      "적일", "있을", "없을", "않을", "려는", "으려는", "시는", "으신", "쁘신", "르신", "어든",
                      "아든", "만든", "긴", "적인")):
        return True
    if last == "는":
        if not prev or not _is_hangul(prev):
            return False                      # "AI는", "2는" -> topic
        if core.endswith(("에는", "에서는", "로는", "으로는", "서는", "까지는", "부터는", "만큼은", "때는",
                          "것은", "거는", "들은", "들는", "님은", "님들은")):
            return False
        if _jong(prev) in (18, 20):          # 있는, 없는, 재밌는, 했는
            return True
        return prev in NEUN_VERB_SYLL and len(core) >= 2
    if last == "은":
        if not prev:
            return False
        if core.endswith(("들은", "님은", "만큼은", "것은", "에서은")):
            return False
        return prev in EUN_ADJ_SYLL
    if last == "을":
        return bool(prev) and (_jong(prev) == 20 or prev in "않같좋많작높낮넓깊받맡남늦젊찾먹읽")
    j = _jong(last)
    if j == 4:   # -ㄴ
        if core.endswith(("한", "된", "진", "친", "킨", "린", "준", "온", "낸", "쓴", "큰", "운", "춘", "둔",
                          "꾼", "뀐", "뺀", "본", "간", "든", "난", "인", "신", "선", "논", "잔")):
            if last in "인신선논잔난":       # high noun ambiguity: require verb-like previous syllable
                return core.endswith(("적인", "이신", "하신", "되신", "보신", "오신", "가신"))
            if last == "든":
                return core.endswith(("만든", "만들든"))
            if last in "간본" and len(core) >= 2:
                return _jung(prev) in ("ㅓ", "ㅏ", "ㅕ", "ㅝ", "ㅘ", "ㅐ") and _jong(prev) == 0
            return True
        return False
    if j == 8:   # -ㄹ
        if last in "를들일말날달길물불술글풀벨델텔일룰툴골콜롤셀필울을":
            return core.endswith(("만들", "해낼", "할", "울")) and last not in "를들" and core not in ("서울", "겨울")
        return last in "할될볼갈올줄낼칠킬릴질실쓸클살알팔열놀졸끌밀잘" and core not in ADN_NOUN_EXCEPT
    return False


def left_tags(text):
    """Tags describing how a line would END if it ended with this token."""
    raw = text.strip()
    core = _core(raw)
    tags = set()
    if not core:
        return {"EMPTY"}
    trail = raw[len(raw.rstrip(_TRAIL_PUNCT + _QUOTES)):]
    if "?" in trail or "!" in trail:
        tags.add("END")
    if "…" in trail or ".." in trail:
        tags.add("ELLIPSIS")
    elif "." in trail:
        tags.add("END")
    if "," in trail:
        tags.add("COMMA")
    if core in SENT_ADVERBS:
        tags.add("SADV")
        return tags
    if core in ENUMERATORS and "," in trail:
        tags.add("ENUMERATOR")       # "하나, / 저희는 ..." -> keep the enumerator with its item
        tags.discard("COMMA")
        return tags
    if core in NEG_ADVERBS:
        tags.add("NEG")
        return tags
    if core in DETERMINERS:
        tags.add("DET")
    if _is_number(core):
        tags.add("NUM")
    if core in PREVERBAL_ADVERBS:
        tags.add("PREADV")
    if core in FRAME_ADVERBS:
        tags.add("FRAME")
        return tags
    if core in CLAUSE_NOUNS:
        tags.add("CLAUSE_N")         # "~할 때 /", "~하는 것 /", "~시간 동안 /"
        if core in ("것",):
            tags.add("BOUND_END")
        return tags
    if core in ("수", "줄", "리", "적"):
        tags.add("BOUND_END")        # "할 수 / 있다" handled on the right side
        return tags
    if core in TIME_WORDS:
        tags.add("TIME")
    if tags & {"DET", "PREADV", "TIME", "NUM"} and not (tags & {"END", "COMMA"}):
        return tags
    if "NUM" in tags:
        return tags
    if core in ("그게", "이게", "저게", "그건", "이건", "저건", "누가", "뭐가", "건", "게"):
        tags.add("SUBJ" if core.endswith(("게", "가")) else "TOPIC")
        return tags
    if core in ("그걸", "이걸", "저걸", "뭘", "걸"):
        tags.add("OBJ")
        return tags
    if core in ("다들", "모두들", "우리", "저희", "여러분"):
        tags.add("ADVP" if core == "다들" else "BARE")
        return tags
    if not _is_hangul(core[-1]):
        if "NUM" not in tags:
            tags.add("BARE")       # "AI", "LG", "MCP" ...
        return tags
    if _is_adnominal(core):
        tags.add("ADN")
        return tags
    # sentence-final
    fin = _ends_any(core, FINAL_ENDINGS)
    if fin and "END" not in tags:
        if fin in ("요",):
            tags.add("END")
        elif fin == "다":
            if core not in ("보다", "바다", "하다가") and not core.endswith(("보다", "처럼다")):
                tags.add("END_DA")
        elif fin == "까":
            if not core.endswith("니까"):
                tags.add("END")
        elif fin in ("니", "네", "지", "야", "어", "자"):
            pass                                  # ambiguous: decide below (connective)
        else:
            tags.add("END")
    if tags & {"END", "END_DA"}:
        return tags
    if core.endswith(("까지", "에게", "에게서", "한테도", "에게도", "께도", "에서", "거기서", "여기서", "어디서")):
        tags.add("ADVP")
        return tags
    if core.endswith(("수록", "ㄹ수록")):
        tags.add("CONN")
        return tags
    if core.endswith(("런가", "는가", "은가", "인가", "할까")):
        tags.add("CONN")
        return tags
    if core.endswith("도") and len(core) >= 2 and _jong(core[-2]) == 0 and \
            core[-2] in "겨셔내떼봐줘해와워려져써쳐켜돼둬놔어아여":
        tags.add("CONN")                       # -어도 (보내도, 맡겨도)
        return tags
    q = _ends_any(core, QUOT_ENDINGS)
    if q:
        tags.add("QUOT" if q.endswith("고") or q.endswith("고도") else "ADN")
        return tags
    conn = _ends_any(core, CONN_ENDINGS)
    if conn:
        ok = True
        if conn == "서":
            ok = not core.endswith("에서") and core not in NOUN_SEO and len(core) >= 2 and \
                (_jung(core[-2]) in ("ㅓ", "ㅏ", "ㅐ", "ㅕ", "ㅘ", "ㅝ", "ㅙ", "ㅚ", "ㅞ") and _jong(core[-2]) == 0)
        elif conn in ("면", "으면", "다면", "라면"):
            ok = core not in NOUN_MYEON
        elif conn == "라":
            ok = core not in NOUN_RA and len(core) >= 2
        elif conn == "고":
            ok = core not in NOUN_GO and len(core) >= 2
        elif conn == "니":
            ok = core not in NOUN_NI and len(core) >= 2
        elif conn == "야":
            ok = core not in NOUN_YA and len(core) >= 2
        elif conn == "지":
            ok = core not in NOUN_JI and len(core) >= 2
        elif conn in ("든", "자", "건"):
            ok = len(core) >= 2 and conn != "건"
        if ok:
            if conn == "고":
                tags.add("CONN_GO")
            elif conn in ("어야", "아야", "해야", "워야", "러야", "야"):
                tags.add("CONN_YA")
            elif conn == "지":
                tags.add("CONN_JI")
            elif conn in ("면", "으면", "다면", "라면"):
                tags.add("CONN_MYEON")
            elif conn in ("든지", "든가", "든"):
                tags.add("ENUM")
            else:
                tags.add("CONN")
            return tags
    # verbal connective -아/-어 (해, 봐, 줘, 가르쳐 ...) : aux verb may follow
    if len(core) >= 2 or core in ("해", "봐", "줘", "써", "가", "와"):
        last = core[-1]
        prev = core[-2] if len(core) >= 2 else ""
        va = False
        if last in "해봐줘쳐켜워여려져돼춰뤄눠꿔둬놔써펴":
            va = True
        elif last in "아어":
            va = bool(prev) and (_jong(prev) > 0 or prev in "되") and core not in ("사티아",)
        elif last == "와":
            va = core.endswith(("져와", "써와", "도와", "해와", "봐와", "가져와"))
        if va:
            tags.add("VA")      # verb in -아/-어 form
            return tags
    # adverbial -게 / -히 / -이
    if core.endswith("게") and len(core) >= 2 and core not in ("이게", "그게", "저게", "뭐게"):
        tags.add("ADVZ_GE")
        return tags
    if core.endswith(("기도", "기는", "기로", "기만", "기까지")) and not core.endswith(("얘기도", "이야기도",
                                                                                     "얘기는", "이야기는")):
        tags.add("NOMZ_GI")
        return tags
    # particles
    if core.endswith("의") and len(core) >= 2:
        tags.add("GEN")
        return tags
    if core.endswith(("은", "는", "은요", "는요", "엔", "에는", "에선", "로는", "으로는", "에서는", "만큼은",
                      "까지는", "부터는", "이란")):
        tags.add("TOPIC")
        return tags
    if core.endswith(("께서",)) or (core.endswith(("이", "가")) and len(core) >= 2 and
                                    core not in ("나이", "차이", "아이", "사이", "전문가", "평가", "추가", "국가",
                                                 "작가", "휴가", "대가", "가", "이", "누가", "어디가")):
        tags.add("SUBJ")
        return tags
    if core.endswith(("을", "를")):
        tags.add("OBJ")
        return tags
    if core.endswith(("와", "과", "랑", "이랑", "하고", "이나", "나")) and len(core) >= 2 and \
            core not in ("하나", "나", "누나"):
        tags.add("COORD")
        return tags
    if core.endswith(("도", "만", "조차", "마저", "까지", "부터", "밖에", "처럼", "보다", "마다", "대로",
                      "에", "에서", "에게", "한테", "께", "로", "으로", "로서", "으로서", "로써", "에게서",
                      "한테서", "더러", "같이", "만큼")):
        tags.add("ADVP")
        return tags
    if core.endswith("서") and len(core) >= 2 and core not in NOUN_SEO:
        tags.add("ADVP")
        return tags
    tags.add("BARE")   # bare noun / unknown: probably inside a noun phrase
    return tags


_HEAD_TAGS = {"TOPIC", "SUBJ", "OBJ", "ADVP", "COORD", "GEN", "END", "END_DA", "CONN", "CONN_GO", "CONN_MYEON",
              "CONN_YA", "CONN_JI", "QUOT", "COMMA", "CLAUSE_N", "BOUND_END"}


def right_tags(text, prev_text="", next_text=None):
    """Tags describing how a line would START if it started with this token.

    next_text (optional) is the token after `text`; it lets us tell a one-word noun head
    ("생각하는 / 일은 ...") from a long noun phrase ("말하는 / 비즈니스 레벨에서 ...").
    """
    raw = text.strip()
    core = _core(raw.lstrip(_QUOTES))
    tags = set()
    if not core:
        return {"EMPTY"}
    if core in SENT_ADVERBS or core.rstrip(",") in SENT_ADVERBS:
        tags.add("SADV")
    if core in ENUMERATORS and raw.rstrip(_QUOTES).endswith(","):
        tags.add("ENUMERATOR")
    if core in TIME_WORDS:
        tags.add("TIME")
    if core in PARTICLE_WORDS:
        tags.add("PARTICLE")
    if _bound_noun(core):
        tags.add("BOUND")
    pcore = _core(prev_text)
    if pcore and _is_number(pcore) and _starts_with_counter(core) and not core.startswith(("일부", "일을",
                                                                                            "일은", "일이")):
        tags.add("COUNTER")
    if pcore and re.search(r"[0-9]$", pcore) and re.match(r"^[0-9]", core) and prev_text.strip().endswith(","):
        tags.add("NUMLIST")
    # aux verb after -아/-어, -고, -지, -야, -게, -기도
    if pcore:
        lt = left_tags(prev_text)
        if "VA" in lt and core.startswith(AUX_PREFIXES["a"]) and not core.startswith(("가장", "가지", "가능",
                                                                                     "오늘", "오히려", "지금",
                                                                                     "대한", "대해", "두",
                                                                                     "내", "가르", "가져")):
            tags.add("AUX")
        if "CONN_GO" in lt and core.startswith(AUX_PREFIXES["go"]) and not core.startswith(("말씀", "나누",
                                                                                           "나이", "나델라")):
            tags.add("AUX")
        if "CONN_JI" in lt and core.startswith(AUX_PREFIXES["ji"]):
            tags.add("AUX")
        if "CONN_YA" in lt and core.startswith(AUX_PREFIXES["ya"]) and not core.startswith(("하나", "하지만")):
            tags.add("AUX")
        if "ADVZ_GE" in lt and core.startswith(AUX_PREFIXES["ge"]) and not core.startswith(("하나", "하지만")):
            tags.add("AUX")
        if "NOMZ_GI" in lt and core.startswith(AUX_PREFIXES["gi"]):
            tags.add("AUX")
        if "CONN_MYEON" in lt and core.startswith(AUX_PREFIXES["myeon"]) and core not in ("안",):
            tags.add("AUX")
        if pcore in ("수", "줄", "리", "적") and core.startswith(("있", "없", "밖에", "있을", "없을", "알", "몰")):
            tags.add("AUX")          # 할 수 / 있다, 할 줄 / 알다, 본 적 / 있다
        if pcore == "것" and core.startswith(("같", "이다", "입니다", "이에요", "이죠", "이고")):
            tags.add("AUX")          # 것 / 같아요
        if "QUOT" in lt and core.startswith(QUOTE_VERBS):
            tags.add("QUOTV")
        if pcore.endswith(("려고", "으려고")) and core.startswith(("하", "해", "했", "합", "할", "한")):
            tags.add("AUX")          # -려고 / 하다
        if pcore.endswith("도") and "CONN" in lt and core.startswith(("되", "돼", "됩", "됐", "될", "된", "괜찮")):
            tags.add("AUX")          # -어도 / 되다
        if pcore.endswith(("게끔", "도록")) and core.startswith(("되", "돼", "됩", "됐", "하", "해", "했", "만들")):
            tags.add("AUX")          # -게끔 / 되다
        if pcore.endswith("라") and "CONN" in lt and core.startswith(("생각", "보", "봅", "봐", "믿", "하", "합",
                                                                       "해", "했", "느껴", "말")):
            tags.add("QUOTV")        # (거)라 / 생각합니다
        if pcore.endswith(("을까", "ㄹ까", "할까", "않을까", "는가", "인가")) and \
                core.startswith(("생각", "싶", "하", "해", "봐", "보", "고민")):
            tags.add("QUOTV")        # 않을까 / 생각합니다
        if "END_DA" in lt and core.startswith(("보니", "보면", "싶")):
            tags.add("AUX")   # -다 보니 / -다 싶
        if "NEG" in left_tags(prev_text) or pcore in NEG_ADVERBS:
            tags.add("AFTER_NEG")
        if "ADN" in lt and "BOUND" not in tags:
            own = left_tags(text)
            nxt = left_tags(next_text) if next_text is not None else set()
            if own & _HEAD_TAGS:
                # one-word head with its particle: "생각하는 / 일은" -> bad
                long_np = bool(own & {"ADVP", "COORD"}) and next_text is not None and \
                    _core(next_text) in ("대한", "관한", "위한", "같은", "따른", "통한", "향한", "대해서")
            elif "BARE" in own:
                # bare noun: compound noun phrase continues ("비즈니스 레벨에서") or the head
                # just dropped its particle ("뽑는다는 / 얘기 많이")
                long_np = bool(nxt & {"BARE", "TOPIC", "SUBJ", "OBJ", "ADVP", "COORD", "GEN", "NUM"}) and \
                    not (nxt & {"PREADV", "ADN", "VA", "CONN", "CONN_GO", "END", "END_DA"})
            else:
                long_np = True          # DET / NUM / ADN / ENUM start a longer noun phrase
            tags.add("ADN_LONGNP" if long_np else "HEAD1")
    return tags


def break_analysis(w1, w2, w3=None):
    return left_tags(w1), right_tags(w2, w1, w3)


# --------------------------------------------------------------------------
# Costs: a linear model over break features + line features, minimised by DP
# --------------------------------------------------------------------------
PAUSE_BINS = (0.05, 0.15, 0.30, 0.60, 1.20)   # P0 <0.05 | P1 | P2 | P3 | P4 | P5 >=1.2 s

DEFAULT_PARAMS = {
    # weight of each break feature (positive = discourage a break there)
    "w": {
        "BASE": 2.0,
        # tag of the word BEFORE the break (how the line would end)
        "L:END": -4.5, "L:END_DA": -3.0, "L:ELLIPSIS": -3.0, "L:COMMA": -3.0, "L:CONN": -1.2,
        "L:CONN_GO": -1.6, "L:CONN_MYEON": -1.6, "L:CONN_YA": -0.8, "L:CONN_JI": -0.6, "L:ENUM": -0.8,
        "L:QUOT": 0.6, "L:TOPIC": -1.2, "L:SUBJ": 0.0, "L:OBJ": 0.6, "L:ADVP": 1.0, "L:COORD": 0.9,
        "L:TIME": 1.0, "L:VA": -0.5, "L:ADVZ_GE": 0.8, "L:NOMZ_GI": 1.5, "L:GEN": 3.5, "L:ADN": 1.5,
        "L:BARE": 2.6, "L:DET": 5.0, "L:NUM": 2.0, "L:PREADV": 3.0, "L:NEG": 6.0, "L:SADV": 3.0,
        "L:FRAME": 0.5, "L:CLAUSE_N": -0.6, "L:BOUND_END": 1.0, "L:ENUMERATOR": 3.0,
        # tag of the word AFTER the break (how the next line would start)
        "R:SADV": -1.4, "R:TIME": -0.4, "R:BOUND": 6.0, "R:PARTICLE": 6.0, "R:COUNTER": 6.0, "R:AUX": 4.5,
        "R:QUOTV": 2.0, "R:AFTER_NEG": 0.0, "R:NUMLIST": 3.0, "R:HEAD1": 2.5, "R:ADN_LONGNP": -1.5,
        "R:ENUMERATOR": -1.5,
        # pause before the next word (P1 0.05-0.15 s, P2 0.15-0.3, P3 0.3-0.6, P4 0.6-1.2, P5 >= 1.2)
        "P1": -1.5, "P2": -3.0, "P3": -3.8, "P4": -4.2, "P5": -4.6,
        # line-shape features (per line)
        "LN:SHORT": 1.5,      # per char below min_chars, incomplete line
        "LN:SHORT_C": 0.35,   # per char below min_chars, line ends a sentence / comma
        "LN:LONG": 0.25,      # per char above target_chars
        "LN:OVER": 1.2,       # per char above max_chars
        "LN:OVER2": 0.6,      # (chars above max_chars)^2
    },
    "target_chars": 14,
    "max_overflow": 3,        # hard cap = max_chars + max_overflow (a single long word may still exceed it)
    # meaning-protecting floors: after any re-weighting these features never cost less than this
    "floors": {"R:BOUND": 4.0, "R:AUX": 4.0, "R:COUNTER": 4.0, "R:PARTICLE": 4.0, "L:NEG": 4.0, "L:DET": 4.0,
               "L:ADN": 1.5, "L:PREADV": 1.5, "L:GEN": 1.5, "L:BARE": 1.5, "L:NUM": 1.5, "L:SADV": 1.5,
               "R:QUOTV": 1.0, "L:NOMZ_GI": 1.0, "R:HEAD1": 2.5},
}


def _merge_params(params):
    p = {"w": dict(DEFAULT_PARAMS["w"]), "target_chars": DEFAULT_PARAMS["target_chars"],
         "max_overflow": DEFAULT_PARAMS["max_overflow"], "floors": dict(DEFAULT_PARAMS["floors"])}
    if params:
        for k, v in params.items():
            if k in ("w", "floors") and isinstance(v, dict):
                p[k].update(v)
            else:
                p[k] = v
    for f, lo in p["floors"].items():
        if p["w"].get(f, 0.0) < lo:
            p["w"][f] = lo
    return p


def estimate_pauses(words, mode="auto"):
    """pause[i] = silence (s) between words[i-1] and words[i]; pause[0] = 0.

    mode="gap"  : plain gap end->start (accurate timestamps).
    mode="auto" : gap, plus a correction for Whisper-style timestamps where the
                  silence is absorbed into the next word (abnormally long word
                  duration).  expected duration ~ 0.12 s + 0.11 s/char.
    """
    n = len(words)
    out = [0.0] * n
    for i in range(1, n):
        a, b = words[i - 1], words[i]
        gap = float(b.get("start", 0.0)) - float(a.get("end", 0.0))
        p = max(0.0, gap)
        if mode == "auto":
            core = _core(b["text"])
            dur = float(b.get("end", 0.0)) - float(b.get("start", 0.0))
            expected = 0.12 + 0.11 * max(1, len(core.replace(" ", "")))
            excess = dur - 2.0 * expected
            if excess > 0:
                p = max(p, min(excess, 3.0))
        out[i] = p
    return out


def pause_bin(pause):
    k = 0
    for edge in PAUSE_BINS:
        if pause >= edge:
            k += 1
    return k


def break_features(lt, rt, pause):
    """Binary features of a break between a word with left-tags lt and a word with right-tags rt."""
    f = ["BASE"]
    f.extend("L:" + t for t in lt if t != "EMPTY")
    f.extend("R:" + t for t in rt if t != "EMPTY")
    k = pause_bin(pause)
    if k:
        f.append("P%d" % k)
    return f


def line_features(nchars, last_tags, max_chars, min_chars, target_chars):
    f = {}
    if nchars < min_chars:
        complete = bool(last_tags & {"END", "END_DA", "COMMA", "ELLIPSIS"})
        f["LN:SHORT_C" if complete else "LN:SHORT"] = float(min_chars - nchars)
    if nchars > target_chars:
        f["LN:LONG"] = float(nchars - target_chars)
    if nchars > max_chars:
        over = float(nchars - max_chars)
        f["LN:OVER"] = over
        f["LN:OVER2"] = over * over
    return f


def _prepare(words, pauses, pause_mode):
    texts = [w["text"].strip() for w in words]
    if pauses is None:
        pauses = estimate_pauses(words, pause_mode)
    ltags = [left_tags(t) for t in texts]
    n = len(words)
    bfeats = [None] + [break_features(ltags[i - 1],
                                      right_tags(texts[i], texts[i - 1], texts[i + 1] if i + 1 < n else None),
                                      pauses[i])
                       for i in range(1, n)]
    return texts, ltags, bfeats


def split_lines(words, max_chars=22, min_chars=5, params=None, pauses=None, pause_mode="auto",
                return_cost=False, _prepared=None):
    """Split a word sequence into subtitle lines.

    words     : list of {"text", "start", "end"} (eojeol tokens, punctuation attached)
    max_chars : soft max characters per line incl. spaces (hard cap = max_chars + params["max_overflow"])
    min_chars : lines shorter than this are penalised (less if they end a sentence)
    pauses    : optional precomputed pause list (seconds before each word);
                default estimate_pauses(words, pause_mode)  ("gap" for accurate timestamps,
                "auto" also repairs Whisper's habit of stretching the word after a pause)
    returns   : sorted list of line-start indices, starting with 0 ([] for empty input)
    """
    n = len(words)
    if n == 0:
        return []
    p = _merge_params(params)
    w = p["w"]
    texts, ltags, bfeats = _prepared if _prepared else _prepare(words, pauses, pause_mode)
    lens = [len(t) for t in texts]
    bcost = [0.0] * (n + 1)
    for i in range(1, n):
        bcost[i] = sum(w.get(f, 0.0) for f in bfeats[i])
    hard_cap = max_chars + p["max_overflow"]
    tc = p["target_chars"]
    INF = float("inf")
    best = [INF] * (n + 1)
    back = [0] * (n + 1)
    best[0] = 0.0
    for i in range(n):            # a line starts at word i
        if best[i] == INF:
            continue
        base = best[i] + (bcost[i] if i > 0 else 0.0)
        nch = -1
        for j in range(i + 1, n + 1):   # line = words[i:j]
            nch += lens[j - 1] + 1
            if nch > hard_cap and j - i > 1:
                break
            lf = line_features(nch, ltags[j - 1], max_chars, min_chars, tc)
            c = base + sum(w.get(k, 0.0) * v for k, v in lf.items())
            if c < best[j]:
                best[j] = c
                back[j] = i
    starts = []
    j = n
    while j > 0:
        i = back[j]
        starts.append(i)
        j = i
    starts.reverse()
    if return_cost:
        return starts, best[n]
    return starts


def segmentation_features(words, starts, max_chars=22, min_chars=5, params=None, _prepared=None,
                          pauses=None, pause_mode="auto"):
    """Feature counts of a given segmentation (used for learning the weights)."""
    p = _merge_params(params)
    texts, ltags, bfeats = _prepared if _prepared else _prepare(words, pauses, pause_mode)
    phi = {}
    bounds = list(starts) + [len(words)]
    for a, b in zip(bounds, bounds[1:]):
        if a > 0:
            for f in bfeats[a]:
                phi[f] = phi.get(f, 0.0) + 1.0
        nch = len(" ".join(texts[a:b]))
        for k, v in line_features(nch, ltags[b - 1], max_chars, min_chars, p["target_chars"]).items():
            phi[k] = phi.get(k, 0.0) + v
    return phi


def lines_from_starts(words, starts):
    out = []
    bounds = list(starts) + [len(words)]
    for a, b in zip(bounds, bounds[1:]):
        out.append(words[a:b])
    return out


# --------------------------------------------------------------------------
# Meaning-break detector (used for evaluation; independent of the cost weights)
# --------------------------------------------------------------------------
BAD_PATTERNS = [
    # (name, description, severity)
    ("BOUND", "의존명사가 다음 줄 첫머리 (할 / 수, 대신할 / 거라고, 나을 / 때는)", 3),
    ("AUX", "본용언-보조용언 분리 (해 / 보겠습니다, 하고 / 있습니다, 하지 / 않습니다)", 3),
    ("NEG", "부정 부사 '안/못'이 줄 끝 (안 / 뽑으려고)", 3),
    ("COUNTER", "수사-단위명사 분리 (한 / 분, 30 / 개)", 3),
    ("PARTICLE", "조사·서술격조사 단독 어절이 줄 첫머리", 3),
    ("DET", "관형사/지시어가 줄 끝 (그 / 일, 이 / 교육, 모든 / 일)", 2),
    ("ADN", "관형형 어미가 줄 끝, 꾸밈받는 한 어절 명사가 다음 줄 (생각하는 / 일은)", 2),
    ("ADN_LONGNP", "(strict 모드) 관형절 / 여러 어절 명사구 (말하는 / 비즈니스 레벨에서) - 사용자도 허용", 1),
    ("GEN", "관형격 '의'가 줄 끝 (팀원의 / 성장)", 2),
    ("PREADV", "부사가 줄 끝, 꾸밈받는 용언이 다음 줄 (많이 / 써본, 끝까지 / 물고)", 2),
    ("NP", "조사 없는 명사가 줄 끝 = 복합명사/명사구 분리 (비즈니스 / 레벨, 토큰 / 자본)", 2),
    ("QUOTE", "인용 '-다고/-라고'와 인용동사 분리 (늘었다고 / 하더라고요)", 1),
    ("SADV_END", "접속부사가 줄 끝에 매달림 (… 그래서 / …)", 1),
    ("DANGLE", "3자 이하 짧은 줄인데 완결 단위가 아님", 1),
]
_PATTERN_SEVERITY = {k: s for k, _, s in BAD_PATTERNS}


def boundary_violations(w1, w2, w3=None, strict_adn=False):
    """List of bad-pattern names for a line break between token w1 and token w2 (w3 = token after w2).

    ADN (modifier / head split) is reported only when the head is a one-word noun phrase
    ("생각하는 / 일은"); a break in front of a multi-word noun phrase ("말하는 / 비즈니스 레벨에서")
    is the lesser evil and is reported as ADN_LONGNP only when strict_adn=True.
    """
    lt = left_tags(w1)
    rt = right_tags(w2, w1, w3)
    v = []
    if "BOUND" in rt:
        v.append("BOUND")
    if "AUX" in rt:
        v.append("AUX")
    if "NEG" in lt:
        v.append("NEG")
    if "COUNTER" in rt:
        v.append("COUNTER")
    if "PARTICLE" in rt:
        v.append("PARTICLE")
    if v:
        return v
    if "END" in lt or "END_DA" in lt or "COMMA" in lt or "ELLIPSIS" in lt:
        return v
    if "DET" in lt and "TIME" not in lt:
        v.append("DET")
    elif "ADN" in lt:
        if "HEAD1" in rt:
            v.append("ADN")
        elif strict_adn:
            v.append("ADN_LONGNP")
    elif "GEN" in lt:
        v.append("GEN")
    elif "PREADV" in lt:
        v.append("PREADV")
    elif "BARE" in lt and not (rt & {"SADV", "TIME"}):
        v.append("NP")
    elif "QUOT" in lt and "QUOTV" in rt:
        v.append("QUOTE")
    elif "SADV" in lt:
        v.append("SADV_END")
    elif "ENUMERATOR" in lt:
        v.append("SADV_END")
    return v


def detect_bad_breaks(words, starts, dangle_chars=3, np_pause_exempt=0.4, strict_adn=False):
    """Return a list of {"index", "left", "right", "patterns"} for every bad line break,
    plus DANGLE entries for very short incomplete lines.

    NP (noun-phrase split) is not reported when the speaker paused >= np_pause_exempt
    seconds after the noun (nominal sentence / list item), and PREADV is not reported
    for '함께/같이' used as a postposition after -와/-과/-랑.
    """
    texts = [w["text"] if isinstance(w, dict) else str(w) for w in words]
    has_t = bool(words) and isinstance(words[0], dict) and "start" in words[0]
    out = []
    for s in starts:
        if s <= 0 or s >= len(texts):
            continue
        v = boundary_violations(texts[s - 1], texts[s], texts[s + 1] if s + 1 < len(texts) else None,
                                strict_adn=strict_adn)
        if v and v == ["NP"] and has_t:
            gap = float(words[s]["start"]) - float(words[s - 1]["end"])
            if gap >= np_pause_exempt:
                v = []
        if v and v == ["PREADV"] and _core(texts[s - 1]) in ("함께", "같이") and s >= 2 and \
                "COORD" in left_tags(texts[s - 2]):
            v = []
        if v:
            out.append({"index": s, "left": texts[s - 1], "right": texts[s], "patterns": v})
    bounds = list(starts) + [len(texts)]
    for a, b in zip(bounds, bounds[1:]):
        if b <= a:
            continue
        lt = " ".join(t.strip() for t in texts[a:b])
        if len(lt) <= dangle_chars and _core(lt) not in SHORT_OK_LINES:
            tags = left_tags(texts[b - 1])
            if not (tags & {"END", "END_DA", "COMMA", "ELLIPSIS"}):
                out.append({"index": a, "left": lt, "right": "", "patterns": ["DANGLE"]})
    return out


def caption_text(ws):
    """Caption text for one line, following the team's SRT convention:
    tokens joined by single spaces, ',' '?' '!' kept, sentence-final '.' dropped
    (Whisper emits it).  '...' (false start marker) is kept."""
    out = []
    for w in ws:
        t = (w["text"] if isinstance(w, dict) else str(w)).strip()
        if not t:
            continue
        if t.endswith(".") and not t.endswith("..") and not re.search(r"[0-9]\.$", t):
            t = t[:-1]
        if t:
            out.append(t)
    return " ".join(out)


def make_cues(words, starts, contiguous=True, max_hold=1.0, min_dur=0.5):
    """Cues {start, end, text} for each line.

    The user's exported SRT (cut timeline, silences removed) is fully contiguous:
    cue end == next cue start.  On an uncut timeline set contiguous=True to hold a
    cue until the next one starts only when the gap is <= max_hold seconds.
    """
    lines = lines_from_starts(words, starts)
    cues = []
    for k, ln in enumerate(lines):
        st_ = float(ln[0].get("start", 0.0))
        en = float(ln[-1].get("end", st_))
        if contiguous and k + 1 < len(lines):
            nxt = float(lines[k + 1][0].get("start", en))
            if nxt - en <= max_hold:
                en = nxt
        if en - st_ < min_dur:
            en = st_ + min_dur
        cues.append({"start": round(st_, 3), "end": round(en, 3), "text": caption_text(ln)})
    for k in range(len(cues) - 1):          # never overlap the next cue
        if cues[k]["end"] > cues[k + 1]["start"]:
            cues[k]["end"] = cues[k + 1]["start"]
    return cues


def _load_words_json(path):
    import json
    with open(path, encoding="utf-8") as f:
        r = json.load(f)
    ws = []
    if isinstance(r, dict) and "segments" in r:            # whisper / mlx-whisper
        for seg in r["segments"]:
            for w in seg.get("words", []):
                t = w.get("word", w.get("text", "")).strip()
                if t:
                    ws.append({"text": t, "start": float(w["start"]), "end": float(w["end"])})
    elif isinstance(r, list):                              # [{"text","start","end"}]
        ws = [w for w in r if str(w.get("text", "")).strip()]
    return ws


