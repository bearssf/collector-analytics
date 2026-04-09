"""
Stage 2: OpenAlex + Semantic Scholar retrieval from Stage 1 decomposition (no Bedrock).
Progress lines on stderr: STAGE2_PROG {"event":"progress",...}
Final JSON on stdout.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from difflib import SequenceMatcher
from typing import Any, Callable, Optional

LOG = logging.getLogger("stage2_retrieval")

OPENALEX_BASE = "https://api.openalex.org"
S2_BASE = "https://api.semanticscholar.org/graph/v1"
REQUEST_TIMEOUT = 30
OPENALEX_DELAY_SEC = 1.0
S2_MAX_REQ = 100
S2_WINDOW_SEC = 300

CORPUS_TARGET: dict[str, int] = {
    "assignment": 40,
    "dissertation": 350,
    "conference": 100,
    "journal": 200,
}

RECENCY_WEIGHT: dict[str, float] = {
    "assignment": 0.3,
    "dissertation": 0.15,
    "conference": 0.4,
    "journal": 0.2,
}

TITLE_FUZZY_THRESHOLD = 0.90


def _http_get_json(url: str, headers: Optional[dict[str, str]] = None) -> dict[str, Any]:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "AcademiqForge-Stage2/1.0"})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def http_get_json_polite(url: str, *, sleep_after: float = 0.0) -> dict[str, Any]:
    try:
        return _http_get_json(url)
    finally:
        if sleep_after > 0:
            time.sleep(sleep_after)


def reconstruct_abstract(inv: Any) -> str:
    if not inv or not isinstance(inv, dict):
        return ""
    positions: list[tuple[int, str]] = []
    for word, idxs in inv.items():
        if not isinstance(idxs, list):
            continue
        for i in idxs:
            try:
                positions.append((int(i), word))
            except (TypeError, ValueError):
                continue
    positions.sort(key=lambda x: x[0])
    return " ".join(w for _, w in positions)


def normalize_doi(doi: Any) -> str:
    if doi is None:
        return ""
    s = str(doi).strip().lower()
    s = re.sub(r"^https?://(dx\.)?doi\.org/", "", s)
    return s


def normalize_title_key(title: Any) -> str:
    if not title:
        return ""
    s = str(title).lower()
    s = re.sub(r"[^\w\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def title_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def extract_year(work: dict[str, Any]) -> Optional[int]:
    y = work.get("publication_year")
    if y is not None:
        try:
            return int(y)
        except (TypeError, ValueError):
            pass
    pd = work.get("publication_date")
    if pd and isinstance(pd, str) and len(pd) >= 4:
        try:
            return int(pd[:4])
        except ValueError:
            pass
    return None


def parse_recommended_range(rng: Any) -> tuple[Optional[int], Optional[int]]:
    if rng is None:
        return None, None
    s = str(rng).strip()
    m = re.match(r"(\d{4})\s*[-–]\s*(\d{4})", s)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.search(r"(\d{4})", s)
    if m:
        y = int(m.group(1))
        return y, y
    return None, None


def openalex_normalize_work(w: dict[str, Any], query_purpose: str) -> dict[str, Any]:
    wid = w.get("id") or ""
    if isinstance(wid, str) and "/" in wid:
        wid = wid.rstrip("/").split("/")[-1]

    doi = None
    ids = w.get("ids") or {}
    if isinstance(ids, dict):
        doi = ids.get("doi")
    if not doi and w.get("doi"):
        doi = w["doi"]

    authors: list[dict[str, str]] = []
    for a in w.get("authorships") or []:
        if not isinstance(a, dict):
            continue
        auth = a.get("author") or {}
        name = auth.get("display_name") or ""
        inst = ""
        insts = a.get("institutions") or []
        if insts and isinstance(insts[0], dict):
            inst = insts[0].get("display_name") or ""
        if name:
            authors.append({"name": name, "institution": inst})

    venue = ""
    pl = w.get("primary_location") or {}
    if isinstance(pl, dict):
        src = pl.get("source") or {}
        if isinstance(src, dict):
            venue = src.get("display_name") or ""

    oa_url = ""
    boa = w.get("best_oa_location") or {}
    if isinstance(boa, dict):
        oa_url = boa.get("landing_page_url") or ""
    oa = w.get("open_access") or {}
    if isinstance(oa, dict) and not oa_url:
        oa_url = oa.get("oa_url") or ""

    concepts_out: list[dict[str, Any]] = []
    for c in w.get("concepts") or []:
        if not isinstance(c, dict):
            continue
        nm = c.get("display_name") or ""
        sc = c.get("score")
        try:
            scf = float(sc) if sc is not None else 0.0
        except (TypeError, ValueError):
            scf = 0.0
        if nm:
            concepts_out.append({"name": nm, "score": scf})

    ref_ids: list[str] = []
    for r in w.get("referenced_works") or []:
        if isinstance(r, str):
            ref_ids.append(r.rstrip("/").split("/")[-1] if "/" in r else r)

    inv = w.get("abstract_inverted_index")
    abstract = reconstruct_abstract(inv)
    cy = extract_year(w)

    return {
        "source": "openalex",
        "source_id": wid,
        "doi": normalize_doi(doi) or None,
        "title": (w.get("title") or "") or "",
        "abstract": abstract,
        "authors": authors,
        "year": cy,
        "venue": venue,
        "citation_count": int(w.get("cited_by_count") or 0),
        "concepts": concepts_out,
        "referenced_works": ref_ids,
        "open_access_url": oa_url or None,
        "_query_hits": [query_purpose],
    }


def semantic_scholar_normalize(p: dict[str, Any], query_purpose: str) -> dict[str, Any]:
    pid = p.get("paperId") or ""
    ext = p.get("externalIds") or {}
    doi = ext.get("DOI") if isinstance(ext, dict) else None

    authors_out: list[dict[str, str]] = []
    for a in p.get("authors") or []:
        if not isinstance(a, dict):
            continue
        name = a.get("name") or ""
        inst = ""
        aff = a.get("affiliations")
        if isinstance(aff, list) and aff:
            if isinstance(aff[0], str):
                inst = aff[0]
            elif isinstance(aff[0], dict):
                inst = aff[0].get("name") or ""
        if name:
            authors_out.append({"name": name, "institution": inst})

    venue = p.get("venue") or ""
    if isinstance(venue, dict):
        venue = venue.get("name") or ""

    tldr = None
    t = p.get("tldr")
    if isinstance(t, dict):
        tldr = t.get("text")
    elif isinstance(t, str):
        tldr = t

    ref_ids: list[str] = []
    for r in p.get("references") or []:
        if isinstance(r, dict) and r.get("paperId"):
            ref_ids.append(str(r["paperId"]))
        elif isinstance(r, str):
            ref_ids.append(r)

    oa_pdf = p.get("openAccessPdf") or {}
    oa_url = oa_pdf.get("url") if isinstance(oa_pdf, dict) else ""

    yv = p.get("year")
    try:
        yr = int(yv) if yv is not None else None
    except (TypeError, ValueError):
        yr = None

    return {
        "source": "semantic_scholar",
        "source_id": str(pid),
        "doi": normalize_doi(doi) if doi else None,
        "title": (p.get("title") or "") or "",
        "abstract": (p.get("abstract") or "") or "",
        "authors": authors_out,
        "year": yr,
        "venue": str(venue) if venue else "",
        "citation_count": int(p.get("citationCount") or 0),
        "tldr": tldr,
        "referenced_works": ref_ids,
        "open_access_url": oa_url or None,
        "_query_hits": [query_purpose],
    }


class S2RateLimiter:
    def __init__(self) -> None:
        self._times: deque[float] = deque()

    def wait_turn(self) -> None:
        now = time.time()
        while self._times and now - self._times[0] > S2_WINDOW_SEC:
            self._times.popleft()
        if len(self._times) >= S2_MAX_REQ:
            wait = S2_WINDOW_SEC - (now - self._times[0]) + 0.05
            if wait > 0:
                time.sleep(wait)
            now = time.time()
            while self._times and now - self._times[0] > S2_WINDOW_SEC:
                self._times.popleft()
        self._times.append(time.time())


def resolve_openalex_concept_ids(
    names: list[str],
    mailto: str,
    cache: dict[str, str],
) -> list[str]:
    """Map openalex_concepts display names to OpenAlex concept IDs for filter=concepts.id."""
    ids: list[str] = []
    for raw in names:
        name = str(raw).strip()
        if not name:
            continue
        lk = name.lower()
        if lk in cache:
            cid = cache[lk]
            if cid:
                ids.append(cid)
            continue
        q = urllib.parse.quote(name)
        url = f"{OPENALEX_BASE}/concepts?search={q}&per_page=5&mailto={urllib.parse.quote(mailto)}"
        try:
            data = http_get_json_polite(url, sleep_after=OPENALEX_DELAY_SEC)
            for c in data.get("results") or []:
                if not isinstance(c, dict):
                    continue
                cid_full = c.get("id") or ""
                if isinstance(cid_full, str) and "C" in cid_full:
                    short = cid_full.rstrip("/").split("/")[-1]
                    cache[lk] = short
                    ids.append(short)
                    break
            else:
                cache[lk] = ""
        except Exception as e:
            LOG.warning("OpenAlex concept resolve failed for %s: %s", name, e)
            cache[lk] = ""
    return ids


def build_openalex_works_url(
    keyword_query: str,
    concept_names: list[str],
    date_from: Optional[str],
    date_to: Optional[str],
    mailto: str,
    cursor: Optional[str],
    concept_cache: dict[str, str],
) -> str:
    params: list[tuple[str, str]] = [("mailto", mailto), ("per_page", "200")]
    if keyword_query and str(keyword_query).strip():
        params.append(("search", str(keyword_query).strip()))

    filters: list[str] = []
    if date_from:
        filters.append(f"from_publication_date:{date_from}")
    if date_to:
        filters.append(f"to_publication_date:{date_to}")

    cids = resolve_openalex_concept_ids(concept_names, mailto, concept_cache)
    if cids:
        filters.append("concepts.id:" + "|".join(cids))

    if filters:
        params.append(("filter", ",".join(filters)))
    if cursor:
        params.append(("cursor", cursor))

    q = urllib.parse.urlencode(params, safe="|,:")
    return f"{OPENALEX_BASE}/works?{q}"


def fetch_openalex_for_query(
    rq: dict[str, Any],
    temporal: dict[str, Any],
    mailto: str,
    concept_cache: dict[str, str],
    skipped: list[dict[str, str]],
    purpose: str,
) -> list[dict[str, Any]]:
    kw = rq.get("keyword_query") or ""
    concepts = rq.get("openalex_concepts") or []
    if isinstance(concepts, str):
        concepts = [concepts]
    tp = temporal or {}
    y0, y1 = parse_recommended_range(tp.get("recommended_range"))
    date_from = f"{y0}-01-01" if y0 else None
    date_to = f"{y1}-12-31" if y1 else None
    concept_list = [str(c).strip() for c in concepts if c and str(c).strip()]
    if not str(kw).strip() and not concept_list and not date_from and not date_to:
        return []

    out: list[dict[str, Any]] = []
    cursor: Optional[str] = None
    total = 0
    max_results = 500

    while total < max_results:
        url = build_openalex_works_url(
            str(kw), concept_list, date_from, date_to, mailto, cursor, concept_cache
        )
        try:
            data = http_get_json_polite(url, sleep_after=OPENALEX_DELAY_SEC)
        except Exception as e:
            err = str(e)
            LOG.warning("OpenAlex request failed for %s: %s", purpose, err)
            skipped.append({"purpose": purpose, "api": "openalex", "error": err[:500]})
            break

        results = data.get("results") or []
        for w in results:
            if isinstance(w, dict):
                out.append(openalex_normalize_work(w, purpose))
                total += 1
                if total >= max_results:
                    break

        cursor = (data.get("meta") or {}).get("next_cursor")
        if not cursor or not results:
            break

    return out


def fetch_s2_for_query(
    rq: dict[str, Any],
    limiter: S2RateLimiter,
    skipped: list[dict[str, str]],
    purpose: str,
) -> list[dict[str, Any]]:
    kw = str(rq.get("keyword_query") or "").strip()
    if not kw:
        return []

    fields = (
        "paperId,externalIds,title,abstract,authors,year,venue,citationCount,"
        "references,tldr,citationStyles,openAccessPdf"
    )
    out: list[dict[str, Any]] = []
    offset = 0
    per_page = 100
    max_total = 200

    while len(out) < max_total:
        limiter.wait_turn()
        params = urllib.parse.urlencode(
            {"query": kw, "offset": offset, "limit": per_page, "fields": fields}
        )
        url = f"{S2_BASE}/paper/search?{params}"
        try:
            data = http_get_json_polite(url, sleep_after=0)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                LOG.warning("S2 rate limited; backing off 60s")
                time.sleep(60)
                continue
            skipped.append({"purpose": purpose, "api": "semantic_scholar", "error": str(e)[:500]})
            break
        except Exception as e:
            skipped.append({"purpose": purpose, "api": "semantic_scholar", "error": str(e)[:500]})
            break

        hits = data.get("data") or []
        for p in hits:
            if isinstance(p, dict):
                out.append(semantic_scholar_normalize(p, purpose))
        if len(hits) < per_page or len(out) >= max_total:
            break
        offset += per_page

    return out[:max_total]


def merge_records(oa: dict[str, Any], s2: dict[str, Any]) -> dict[str, Any]:
    m = {k: v for k, v in oa.items() if not str(k).startswith("_")}
    m.pop("source", None)
    qh = list(dict.fromkeys((oa.get("_query_hits") or []) + (s2.get("_query_hits") or [])))
    m["_query_hits"] = qh
    m["sources"] = ["openalex", "semantic_scholar"]
    if s2.get("tldr") and not m.get("tldr"):
        m["tldr"] = s2["tldr"]
    if not m.get("abstract") and s2.get("abstract"):
        m["abstract"] = s2["abstract"]
    if not m.get("doi") and s2.get("doi"):
        m["doi"] = s2["doi"]
    if not m.get("open_access_url") and s2.get("open_access_url"):
        m["open_access_url"] = s2["open_access_url"]
    if not m.get("venue") and s2.get("venue"):
        m["venue"] = s2["venue"]
    if m.get("year") is None and s2.get("year") is not None:
        m["year"] = s2["year"]
    return m


def _merge_query_hits(a: dict[str, Any], b: dict[str, Any]) -> None:
    a["_query_hits"] = list(dict.fromkeys((a.get("_query_hits") or []) + (b.get("_query_hits") or [])))


def deduplicate_papers(papers: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    by_doi: dict[str, dict[str, Any]] = {}
    no_doi: list[dict[str, Any]] = []
    for p in papers:
        d = normalize_doi(p.get("doi") or "")
        if d:
            if d not in by_doi:
                by_doi[d] = p
            else:
                ex = by_doi[d]
                _merge_query_hits(ex, p)
                if ex.get("source") == "openalex" and p.get("source") == "semantic_scholar":
                    by_doi[d] = merge_records(ex, p)
                elif ex.get("source") == "semantic_scholar" and p.get("source") == "openalex":
                    by_doi[d] = merge_records(p, ex)
        else:
            no_doi.append(p)

    merged: list[dict[str, Any]] = list(by_doi.values())
    clusters: list[list[dict[str, Any]]] = []
    for p in no_doi:
        tk = normalize_title_key(p.get("title"))
        placed = False
        for cl in clusters:
            rep = cl[0]
            tr = normalize_title_key(rep.get("title"))
            if title_similarity(tk, tr) >= TITLE_FUZZY_THRESHOLD:
                cl.append(p)
                placed = True
                break
        if not placed:
            clusters.append([p])

    for group in clusters:
        if len(group) == 1:
            merged.append(group[0])
            continue
        oa_g = next((x for x in group if x.get("source") == "openalex"), None)
        s2_g = next((x for x in group if x.get("source") == "semantic_scholar"), None)
        if oa_g and s2_g:
            m = merge_records(oa_g, s2_g)
            for x in group:
                if x is not oa_g and x is not s2_g:
                    _merge_query_hits(m, x)
            merged.append(m)
        else:
            base = group[0]
            for x in group[1:]:
                _merge_query_hits(base, x)
                if base.get("source") == "openalex" and x.get("source") == "semantic_scholar":
                    base = merge_records(base, x)
                elif base.get("source") == "semantic_scholar" and x.get("source") == "openalex":
                    base = merge_records(x, base)
            merged.append(base)

    stats = {"openalex_only": 0, "semantic_scholar_only": 0, "both": 0}
    for p in merged:
        srcs = p.get("sources")
        if isinstance(srcs, list) and "openalex" in srcs and "semantic_scholar" in srcs:
            stats["both"] += 1
        elif p.get("source") == "openalex" or srcs == ["openalex"]:
            stats["openalex_only"] += 1
        else:
            stats["semantic_scholar_only"] += 1

    return merged, stats


def build_construct_keywords(core: list[dict[str, Any]]) -> list[tuple[str, list[str]]]:
    rows: list[tuple[str, list[str]]] = []
    for c in core:
        if not isinstance(c, dict):
            continue
        label = str(c.get("label") or "").strip()
        if not label:
            continue
        terms = [label.lower()]
        for k in ("synonyms", "narrower_terms", "broader_terms"):
            for x in c.get(k) or []:
                if x:
                    terms.append(str(x).lower())
        terms = list(dict.fromkeys(terms))
        rows.append((label, terms))
    return rows


def paper_covers_construct(paper: dict[str, Any], label: str, terms: list[str]) -> bool:
    blob = " ".join(
        [
            str(paper.get("title") or ""),
            str(paper.get("abstract") or ""),
            " ".join(
                c.get("name", "") if isinstance(c, dict) else str(c)
                for c in (paper.get("concepts") or [])
            ),
        ]
    ).lower()
    for t in terms:
        if len(t) >= 3 and t in blob:
            return True
    return label.lower() in blob


def score_papers(
    papers: list[dict[str, Any]],
    retrieval_queries: list[dict[str, Any]],
    core_constructs: list[dict[str, Any]],
    temporal: dict[str, Any],
    project_type: str,
) -> None:
    nq = max(1, len(retrieval_queries))
    max_cite = max((int(p.get("citation_count") or 0) for p in papers), default=0)
    y_min, y_max = parse_recommended_range((temporal or {}).get("recommended_range"))
    recency_weight = RECENCY_WEIGHT.get(project_type, 0.2)
    w_q, w_c = 0.35, 0.25
    w_cv = max(0.0, 1.0 - w_q - w_c - recency_weight)
    construct_rows = build_construct_keywords(core_constructs)
    window_start = (y_max or 2024) - 4

    for p in papers:
        qh = p.get("_query_hits") or []
        unique_q = list(dict.fromkeys(qh))
        query_match = len(unique_q) / nq
        cc = int(p.get("citation_count") or 0)
        cite_imp = math.log1p(cc) / math.log1p(max_cite) if max_cite > 0 else 0.0

        year = p.get("year")
        recency = 0.5
        try:
            yi = int(year) if year is not None else None
        except (TypeError, ValueError):
            yi = None
        if yi is not None:
            if yi >= window_start:
                recency = 1.0
            elif y_min is not None and yi < y_min:
                recency = 0.0
            elif y_max is not None and y_min is not None and y_max > y_min:
                span = y_max - y_min
                dist = y_max - yi
                recency = max(0.0, 1.0 - (dist / max(span, 1)) * 0.8)
            else:
                recency = 0.7

        cov_sum = sum(1.0 for label, terms in construct_rows if paper_covers_construct(p, label, terms))
        concept_cov = cov_sum / max(1, len(construct_rows))

        score = w_q * query_match + w_c * cite_imp + recency_weight * recency + w_cv * concept_cov
        p["relevance_score"] = round(score, 6)
        p["query_hits"] = unique_q


def _paper_key(p: dict[str, Any]) -> str:
    srcs = p.get("sources")
    if isinstance(srcs, list) and srcs:
        src = "+".join(sorted(srcs))
    else:
        src = str(p.get("source") or "")
    return f"{src}:{p.get('source_id')}"


def trim_corpus(
    papers: list[dict[str, Any]],
    core_constructs: list[dict[str, Any]],
    project_type: str,
) -> list[dict[str, Any]]:
    target = CORPUS_TARGET.get(project_type, 200)
    construct_rows = build_construct_keywords(core_constructs)
    papers = sorted(papers, key=lambda p: float(p.get("relevance_score") or 0), reverse=True)

    def covers(p: dict[str, Any], label: str, terms: list[str]) -> bool:
        return paper_covers_construct(p, label, terms)

    selected: dict[str, dict[str, Any]] = {}

    def count_for_label(label: str, terms: list[str]) -> int:
        return sum(1 for p in selected.values() if covers(p, label, terms))

    for label, terms in construct_rows:
        while count_for_label(label, terms) < 5:
            added = False
            for p in papers:
                k = _paper_key(p)
                if k in selected:
                    continue
                if covers(p, label, terms):
                    selected[k] = p
                    added = True
                    break
            if not added:
                break

    for p in papers:
        if len(selected) >= target:
            break
        k = _paper_key(p)
        if k not in selected:
            selected[k] = p

    if len(selected) < target:
        for p in papers:
            if len(selected) >= target:
                break
            k = _paper_key(p)
            if k not in selected:
                selected[k] = p

    result = list(selected.values())
    result.sort(key=lambda p: float(p.get("relevance_score") or 0), reverse=True)

    def removable(p: dict[str, Any]) -> bool:
        for label, terms in construct_rows:
            if not covers(p, label, terms):
                continue
            cnt = sum(1 for x in result if covers(x, label, terms))
            if cnt <= 5:
                return False
        return True

    while len(result) > target:
        cands = [p for p in result if removable(p)]
        if not cands:
            break
        worst = min(cands, key=lambda x: float(x.get("relevance_score") or 0))
        result = [x for x in result if x is not worst]

    rows = build_construct_keywords(core_constructs)
    for p in result:
        p["constructs_covered"] = [
            lab for lab, terms in rows if paper_covers_construct(p, lab, terms)
        ]

    return _strip_internal(result)


def _strip_internal(papers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for p in papers:
        clean = {k: v for k, v in p.items() if not str(k).startswith("_")}
        if "source" in clean and "sources" not in clean:
            clean["sources"] = [clean["source"]]
        elif "sources" not in clean and clean.get("source"):
            clean["sources"] = [clean["source"]]
        out.append(clean)
    return out


def run_stage2(
    decomposition: dict[str, Any],
    *,
    project_type: str,
    mailto: str,
    progress: Optional[Callable[[dict[str, Any]], None]] = None,
) -> dict[str, Any]:
    def emit(ev: dict[str, Any]) -> None:
        if progress:
            progress(ev)

    rq_list = [q for q in (decomposition.get("retrieval_queries") or []) if isinstance(q, dict)]
    temporal = decomposition.get("temporal_parameters") or {}
    core = decomposition.get("core_constructs") or []
    concept_cache: dict[str, str] = {}
    limiter = S2RateLimiter()
    skipped: list[dict[str, str]] = []

    all_oa: list[dict[str, Any]] = []
    all_s2: list[dict[str, Any]] = []
    zero_queries: list[str] = []
    nq = len(rq_list)

    for i, rq in enumerate(rq_list):
        purpose = str(rq.get("purpose") or f"query_{i}")
        emit(
            {
                "event": "progress",
                "index": i + 1,
                "total": max(1, nq),
                "purpose": purpose,
                "api": "openalex",
            }
        )
        try:
            oa = fetch_openalex_for_query(rq, temporal, mailto, concept_cache, skipped, purpose)
        except Exception as e:
            LOG.warning("OpenAlex fetch failed: %s", e)
            skipped.append({"purpose": purpose, "api": "openalex", "error": str(e)[:500]})
            oa = []

        emit(
            {
                "event": "progress",
                "index": i + 1,
                "total": max(1, nq),
                "purpose": purpose,
                "api": "semantic_scholar",
            }
        )
        try:
            s2 = fetch_s2_for_query(rq, limiter, skipped, purpose)
        except Exception as e:
            LOG.warning("S2 fetch failed: %s", e)
            skipped.append({"purpose": purpose, "api": "semantic_scholar", "error": str(e)[:500]})
            s2 = []

        if not oa and not s2:
            zero_queries.append(purpose)

        all_oa.extend(oa)
        all_s2.extend(s2)

    total_before = len(all_oa) + len(all_s2)
    combined = all_oa + all_s2
    merged, source_breakdown = deduplicate_papers(combined)

    score_papers(merged, rq_list, core, temporal, project_type)
    final_papers = trim_corpus(merged, core, project_type)

    construct_rows = build_construct_keywords(core)
    papers_per_construct: dict[str, int] = {}
    for label, terms in construct_rows:
        papers_per_construct[label] = sum(
            1 for p in final_papers if paper_covers_construct(p, label, terms)
        )

    query_purposes = [str(q.get("purpose") or f"query_{i}") for i, q in enumerate(rq_list)]
    papers_per_query: dict[str, int] = {}
    for qp in query_purposes:
        papers_per_query[qp] = sum(1 for p in final_papers if qp in (p.get("query_hits") or []))

    year_dist: dict[str, int] = {}
    for p in final_papers:
        y = p.get("year")
        if y is not None:
            ys = str(int(y))
            year_dist[ys] = year_dist.get(ys, 0) + 1

    for z in zero_queries:
        LOG.warning("Zero results for retrieval query: %s", z)

    stats = {
        "total_retrieved_before_dedup": total_before,
        "total_after_dedup": len(merged),
        "total_after_trimming": len(final_papers),
        "papers_per_construct": papers_per_construct,
        "papers_per_query": papers_per_query,
        "year_distribution": year_dist,
        "zero_result_queries": zero_queries,
        "query_errors": skipped,
        "source_breakdown": source_breakdown,
    }

    return {"corpus": final_papers, "statistics": stats}


def _stderr_progress(obj: dict[str, Any]) -> None:
    sys.stderr.write("STAGE2_PROG " + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    raw = sys.stdin.read()
    payload = json.loads(raw)
    decomp = payload.get("decomposition") or payload
    mailto = str(
        payload.get("mailto") or os.environ.get("OPENALEX_MAILTO") or "bearssf@tiffin.edu"
    )
    pt = str(payload.get("project_type") or payload.get("corpus_project_type") or "dissertation").strip()
    if pt not in CORPUS_TARGET:
        pt = "dissertation"

    result = run_stage2(decomp, project_type=pt, mailto=mailto, progress=_stderr_progress)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
