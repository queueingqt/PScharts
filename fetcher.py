"""
PractiScore fetcher using Playwright for browser automation.

Primary flow:
  1. Login to practiscore.com
  2. Navigate to /associate/step2 — lists matches the user competed in
  3. For each match row, click to open the results popover/frame
  4. Inspect the combined view to find which division the competitor shot
  5. Use the division dropdown to select that division
  6. Read the division-specific Place, Total competitors, Match %, etc.
  7. Return list[MatchResult]
"""

import re
import time
import json
from dataclasses import dataclass, field
from typing import Optional

from playwright.sync_api import sync_playwright, Page, Browser, BrowserContext, Frame


@dataclass
class MatchResult:
    match_name: str = ""
    date: Optional[str] = None
    discipline: str = ""
    division: str = ""
    class_: str = ""
    overall_pct: Optional[float] = None
    hf: Optional[float] = None
    place: Optional[int] = None
    total_competitors: Optional[int] = None
    match_url: str = ""
    raw: dict = field(default_factory=dict)


class PractiScoreFetcher:
    BASE_URL = "https://practiscore.com"

    def __init__(self, headless: bool = True, status_callback=None):
        self.headless = headless
        self.status = status_callback or (lambda msg: None)
        self._pw = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None
        self._captured_json: list[dict] = []

    def __enter__(self):
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(
            headless=self.headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        self._context = self._browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
        )
        self._context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        self._page = self._context.new_page()

        def _on_response(response):
            ct = response.headers.get("content-type", "")
            if "application/json" in ct and response.status == 200:
                try:
                    self._captured_json.append(
                        {"url": response.url, "data": response.json()}
                    )
                except Exception:
                    pass

        self._page.on("response", _on_response)
        return self

    def __exit__(self, *_):
        if self._browser:
            self._browser.close()
        if self._pw:
            self._pw.stop()

    # ------------------------------------------------------------------
    # Auth
    # ------------------------------------------------------------------

    def login(self, username: str, password: str) -> bool:
        page = self._page
        self.status("Navigating to PractiScore login…")
        page.goto(f"{self.BASE_URL}/login", wait_until="domcontentloaded", timeout=15000)

        inputs = page.locator("input").all()
        input_names = [i.get_attribute("name") or i.get_attribute("type") or "?" for i in inputs]
        self.status(f"Login form inputs: {input_names}")

        filled_user = False
        for selector in (
            'input[name="username"]', 'input[name="email"]',
            'input[type="email"]', 'input[name="login"]',
            'input[id="username"]', 'input[id="email"]',
        ):
            if page.locator(selector).count():
                page.fill(selector, username)
                filled_user = True
                self.status(f"Filled username via: {selector}")
                break
        if not filled_user:
            self.status("WARNING: could not find username field")

        filled_pass = False
        for selector in (
            'input[name="password"]', 'input[type="password"]', 'input[id="password"]'
        ):
            if page.locator(selector).count():
                page.fill(selector, password)
                filled_pass = True
                break
        if not filled_pass:
            self.status("WARNING: could not find password field")

        self.status("Waiting for Cloudflare Turnstile…")
        try:
            page.wait_for_function(
                "document.querySelector('input[name=\"cf-turnstile-response\"]')"
                "?.value?.length > 0",
                timeout=15000,
            )
            self.status("Turnstile verified.")
        except Exception:
            self.status("Turnstile timed out — submitting anyway.")

        submitted = False
        for btn in page.locator('button[type="submit"]').all():
            try:
                if btn.is_visible():
                    btn.click(timeout=8000)
                    submitted = True
                    break
            except Exception:
                continue
        if not submitted:
            for sel in ('input[type="submit"]', 'input[name="password"]', 'input[type="password"]'):
                loc = page.locator(sel)
                if loc.count() and loc.first.is_visible():
                    loc.first.press("Enter")
                    submitted = True
                    break

        try:
            page.wait_for_url(lambda url: "/login" not in url, timeout=10000)
        except Exception:
            pass
        try:
            page.wait_for_load_state("domcontentloaded", timeout=8000)
        except Exception:
            pass

        content = page.content().lower()
        current_url = page.url
        self.status(f"Post-login URL: {current_url}")

        logged_in = (
            "logout" in content
            or "sign out" in content
            or "log out" in content
            or "/login" not in current_url
        )
        if not logged_in:
            for sel in (".alert", ".error", '[class*="error"]', '[class*="alert"]'):
                el = page.locator(sel)
                if el.count():
                    self.status(f"Login error: {el.first.inner_text()[:200]}")
                    break
        return logged_in

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def get_results_for_member(
        self,
        member_number: str,
        competitor_name: str = "",
    ) -> list[MatchResult]:
        member_number = member_number.strip().upper()

        results = self._try_step2(competitor_name, member_number)
        if results:
            return results

        self.status("step2 returned no results — no further fallback.")
        return []

    # ------------------------------------------------------------------
    # Strategy: /associate/step2  (popover + division dropdown)
    # ------------------------------------------------------------------

    def _try_step2(self, competitor_name: str, member_number: str) -> list[MatchResult]:
        """
        /associate/step2 shows the logged-in user's match history.
        Each row opens a results popover/frame.  Inside the frame a division
        dropdown lets you switch between division views.

        Flow per match:
          1. Click the row / 'View' button to open the popover.
          2. In the combined (default) view find the competitor's row
             to discover which division they shot.
          3. Use the division dropdown to select that division.
          4. Read Place, total rows, and Match % from the division table.
          5. Close the popover and move on.
        """
        page = self._page
        results = []

        self.status("Loading /associate/step2…")
        try:
            page.goto(
                f"{self.BASE_URL}/associate/step2",
                wait_until="domcontentloaded",
                timeout=15000,
            )
            page.wait_for_load_state("networkidle", timeout=10000)
        except Exception as e:
            self.status(f"step2 load failed: {e}")
            return []

        if "/login" in page.url:
            self.status("Redirected to login — step2 requires authentication.")
            return []
        if "/associate/step2" not in page.url:
            self.status(f"Unexpected redirect: {page.url}")
            return []

        self.status(f"step2 loaded. Title: {page.title()}")

        # Snapshot the match rows before we start clicking
        trigger_count = self._count_step2_triggers(page)
        if trigger_count == 0:
            self.status("No match rows found on step2.")
            self._dump_page_structure(page)
            return []

        self.status(f"Found {trigger_count} match entries on step2.")

        for idx in range(trigger_count):
            self.status(f"Match {idx + 1}/{trigger_count}…")
            try:
                result = self._process_step2_row(page, idx, competitor_name, member_number)
                if result:
                    results.append(result)
                    self.status(
                        f"  ✓ {result.match_name} | div={result.division} "
                        f"| {result.place}/{result.total_competitors} "
                        f"| {result.overall_pct}%"
                    )
                else:
                    self.status(f"  — not found in match {idx + 1}")
            except Exception as e:
                self.status(f"  Error on match {idx + 1}: {e}")

            # Make sure the popover is closed before next row
            self._close_popover(page)

        return results

    # ── Trigger counting / finding ─────────────────────────────────────

    def _count_step2_triggers(self, page: Page) -> int:
        for sel in self._step2_trigger_selectors():
            n = page.locator(sel).count()
            if n:
                self.status(f"step2 triggers via '{sel}': {n}")
                return n
        return 0

    def _step2_trigger_selectors(self) -> list[str]:
        """Ordered list of selectors to try for match row triggers."""
        return [
            # Explicit view/select buttons
            'button:has-text("View")',
            'button:has-text("Select")',
            'a:has-text("View Results")',
            # Links containing results UUIDs
            'a[href*="/results/"]',
            # Table rows with clickable data
            'table tbody tr[onclick]',
            'table tbody tr.clickable',
            'table tbody tr.match-row',
            # Generic data rows (last resort)
            'table tbody tr',
        ]

    def _get_step2_triggers(self, page: Page):
        for sel in self._step2_trigger_selectors():
            locs = page.locator(sel)
            if locs.count():
                return locs
        return None

    # ── Per-row processing ─────────────────────────────────────────────

    def _process_step2_row(
        self,
        page: Page,
        idx: int,
        competitor_name: str,
        member_number: str,
    ) -> Optional[MatchResult]:
        """Click row idx on step2 to open the popover, then extract results."""

        # Click the trigger
        triggers = self._get_step2_triggers(page)
        if triggers is None or idx >= triggers.count():
            return None

        trigger = triggers.nth(idx)
        match_name_guess = trigger.inner_text()[:80].strip().replace("\n", " ")
        self.status(f"  Clicking: '{match_name_guess}'")

        try:
            trigger.click(timeout=8000)
        except Exception as e:
            self.status(f"  Click failed: {e}")
            return None

        # Wait for popover / modal / new content
        popover_sel = self._wait_for_popover(page)
        if not popover_sel:
            self.status("  Popover did not appear.")
            return None

        self.status(f"  Popover appeared (via '{popover_sel}')")

        # Try iframe first, then inline HTML
        frame = self._get_popover_frame(page)
        if frame:
            self.status("  Using iframe context inside popover.")
            return self._extract_from_frame(frame, competitor_name, member_number)
        else:
            self.status("  Using inline popover HTML.")
            return self._extract_from_popover(page, competitor_name, member_number)

    # ── Popover detection ──────────────────────────────────────────────

    def _wait_for_popover(self, page: Page, timeout: int = 8000) -> Optional[str]:
        """Wait for a modal/popover to appear. Returns the selector that matched."""
        candidates = [
            '.modal.show',
            '.modal[style*="display: block"]',
            '[role="dialog"]',
            '.popover',
            '.results-popover',
            '.match-popover',
            '#resultsModal',
            '#matchModal',
            'iframe[src*="practiscore"]',
            'iframe[src*="results"]',
        ]
        for sel in candidates:
            try:
                page.wait_for_selector(sel, timeout=timeout // len(candidates))
                if page.locator(sel).is_visible():
                    return sel
            except Exception:
                continue
        return None

    def _get_popover_frame(self, page: Page) -> Optional[Frame]:
        """Return the iframe Frame inside the popover, if any."""
        for sel in ('iframe[src*="practiscore"]', 'iframe[src*="results"]', '.modal iframe', 'iframe'):
            loc = page.locator(sel)
            if loc.count():
                try:
                    frame = loc.first.content_frame()
                    if frame:
                        frame.wait_for_load_state("domcontentloaded", timeout=6000)
                        return frame
                except Exception:
                    pass
        return None

    def _close_popover(self, page: Page):
        """Try to close any open modal/popover."""
        for sel in (
            'button[data-dismiss="modal"]',
            'button[data-bs-dismiss="modal"]',
            '.modal .close',
            '.modal .btn-close',
            '[aria-label="Close"]',
        ):
            try:
                loc = page.locator(sel)
                if loc.count() and loc.first.is_visible():
                    loc.first.click(timeout=3000)
                    time.sleep(0.4)
                    return
            except Exception:
                pass
        # Fallback: press Escape
        try:
            page.keyboard.press("Escape")
            time.sleep(0.4)
        except Exception:
            pass

    # ── Extraction from inline popover ────────────────────────────────

    def _extract_from_popover(
        self,
        page: Page,
        competitor_name: str,
        member_number: str,
    ) -> Optional[MatchResult]:
        """
        Extract results from a popover rendered inline in the page (not iframe).
        Steps:
          1. Read match name / date from popover header.
          2. Read the current (default/combined) table to find the competitor's division.
          3. Use the division dropdown to switch to that division.
          4. Re-read the table and collect the competitor's row.
        """
        # Scopes to limit DOM search to the popover
        popover_scope = (
            '.modal.show', '[role="dialog"]', '.popover',
            '#resultsModal', '#matchModal', '.results-popover',
        )
        scope_sel = None
        for sel in popover_scope:
            if page.locator(sel).count() and page.locator(sel).is_visible():
                scope_sel = sel
                break

        loc = page.locator(scope_sel) if scope_sel else page

        # ── 1. Match metadata ──────────────────────────────────────────
        match_name, match_date = self._read_popover_metadata(loc)
        self.status(f"  Match: '{match_name}' | Date: '{match_date}'")

        # ── 2. Find competitor's division from combined/default view ───
        division = self._find_competitor_division(loc, competitor_name, member_number)
        if not division:
            self.status("  Could not determine competitor division from default view.")

        # ── 3. Select that division in the dropdown ────────────────────
        if division:
            switched = self._select_division(loc, page, division)
            if switched:
                self.status(f"  Switched dropdown to division: {division}")
                time.sleep(0.8)  # let table re-render
            else:
                self.status(f"  Could not switch dropdown (will use current view).")

        # ── 4. Extract competitor row from (now division-filtered) table ─
        result = self._read_competitor_row(loc, competitor_name, member_number)
        if result:
            result.match_name = match_name or result.match_name
            result.date = match_date or result.date
            if division and not result.division:
                result.division = division
        return result

    # ── Extraction from iframe ─────────────────────────────────────────

    def _extract_from_frame(
        self,
        frame: Frame,
        competitor_name: str,
        member_number: str,
    ) -> Optional[MatchResult]:
        """
        Same as _extract_from_popover but operating inside an iframe Frame.
        The iframe is the full results HTML page (practiscore.com/results/html/…).
        """
        # ── 1. Metadata from iframe's header table ─────────────────────
        match_name, match_date = "", ""
        try:
            header_rows = frame.locator('table tr').all()
            for row in header_rows:
                cells = row.locator('td').all()
                if len(cells) >= 2:
                    label = cells[0].inner_text().lower()
                    value = cells[1].inner_text().strip()
                    if "match name" in label:
                        match_name = value
                    elif "match date" in label:
                        match_date = value
        except Exception:
            pass

        self.status(f"  Frame match: '{match_name}' | {match_date}")

        # ── 2. Find competitor division from combined view ─────────────
        division = self._find_competitor_division_in_frame(frame, competitor_name, member_number)
        if not division:
            self.status("  Could not find competitor in combined frame view.")

        # ── 3. Switch to division view using the page= URL param ──────
        if division:
            div_key = self._division_to_url_key(division)
            current_url = frame.url
            base = current_url.split("?")[0]
            target_url = f"{base}?page=overall-{div_key}"
            self.status(f"  Navigating frame to: {target_url}")
            try:
                frame.goto(target_url, wait_until="domcontentloaded", timeout=10000)
            except Exception as e:
                self.status(f"  Frame navigation failed: {e}")

        # ── 4. Read result ─────────────────────────────────────────────
        result = self._read_competitor_row_from_frame(frame, competitor_name, member_number)
        if result:
            result.match_name = match_name or result.match_name
            result.date = match_date or result.date
            if division and not result.division:
                result.division = division
        return result

    # ── Metadata ───────────────────────────────────────────────────────

    def _read_popover_metadata(self, loc) -> tuple[str, str]:
        """Extract match name and date from the popover header region."""
        match_name = ""
        match_date = ""

        # Try header/title elements
        for sel in ("h1", "h2", "h3", "h4", ".modal-title", ".match-title", ".match-name"):
            try:
                el = loc.locator(sel).first
                if el.is_visible():
                    match_name = el.inner_text().strip()
                    break
            except Exception:
                pass

        # Try a table with "Match Name:" label rows
        try:
            rows = loc.locator("table tr").all()
            for row in rows:
                cells = row.locator("td").all()
                if len(cells) >= 2:
                    label = cells[0].inner_text().strip().lower()
                    value = cells[1].inner_text().strip()
                    if "match name" in label and not match_name:
                        match_name = value
                    elif "match date" in label and not match_date:
                        match_date = value
        except Exception:
            pass

        # Date fallback: look for ISO date in visible text
        if not match_date:
            try:
                text = loc.inner_text()
                m = re.search(r'\b(\d{4}-\d{2}-\d{2})\b', text)
                if m:
                    match_date = m.group(1)
            except Exception:
                pass

        return match_name, match_date

    # ── Division detection ─────────────────────────────────────────────

    def _find_competitor_division(self, loc, competitor_name: str, member_number: str) -> str:
        """
        Read the currently displayed results table (combined/default view)
        and return the Div cell for the competitor's row.
        """
        try:
            rows = loc.locator("table tbody tr").all()
        except Exception:
            return ""

        for row in rows:
            cells = row.locator("td").all()
            if not cells:
                continue
            row_text = " ".join(c.inner_text() for c in cells)
            name_match = competitor_name and competitor_name.lower() in row_text.lower()
            num_match = member_number and member_number.upper() in row_text.upper()
            if not (name_match or num_match):
                continue

            # Find the "Div" column index from the nearest header
            try:
                header = loc.locator("table thead tr th").all()
                header_texts = [h.inner_text().strip().lower() for h in header]
                div_idx = next((i for i, h in enumerate(header_texts) if h in ("div", "division")), -1)
                if div_idx >= 0 and div_idx < len(cells):
                    return cells[div_idx].inner_text().strip()
            except Exception:
                pass

            # Fallback: look for a short uppercase 2-4 char cell (CO, LO, L, O, PCC…)
            for cell in cells:
                val = cell.inner_text().strip()
                if re.match(r'^[A-Z]{1,4}$', val):
                    return val

        return ""

    def _find_competitor_division_in_frame(
        self, frame: Frame, competitor_name: str, member_number: str
    ) -> str:
        """Same as above but works inside an iframe Frame."""
        try:
            from bs4 import BeautifulSoup
            html = frame.content()
            soup = BeautifulSoup(html, "html.parser")

            for table in soup.find_all("table"):
                headers = [th.get_text(strip=True).lower() for th in table.find_all("th")]
                div_idx = next(
                    (i for i, h in enumerate(headers) if h in ("div", "division")), -1
                )
                for row in table.find_all("tr"):
                    cells = row.find_all("td")
                    if not cells:
                        continue
                    row_text = " ".join(c.get_text() for c in cells)
                    name_match = competitor_name and competitor_name.lower() in row_text.lower()
                    num_match = member_number and member_number.upper() in row_text.upper()
                    if name_match or num_match:
                        if div_idx >= 0 and div_idx < len(cells):
                            return cells[div_idx].get_text(strip=True)
                        # Fallback: short uppercase token
                        for c in cells:
                            val = c.get_text(strip=True)
                            if re.match(r'^[A-Z]{1,4}$', val):
                                return val
        except Exception:
            pass
        return ""

    # ── Division dropdown switching ────────────────────────────────────

    def _select_division(self, loc, page: Page, division: str) -> bool:
        """
        Find the division dropdown inside 'loc' and select the option
        matching 'division'.  Handles both <select> and custom dropdowns.
        """
        division_lower = division.lower()
        division_keys = [division_lower, self._division_to_url_key(division)]

        # ── <select> element ────────────────────────────────────────────
        for sel in ("select", 'select[name*="div" i]', 'select[id*="div" i]', 'select[class*="div" i]'):
            try:
                select_loc = loc.locator(sel)
                if select_loc.count():
                    options = select_loc.locator("option").all()
                    for opt in options:
                        opt_text = opt.inner_text().strip().lower()
                        opt_val = (opt.get_attribute("value") or "").lower()
                        if any(k in opt_text or k in opt_val for k in division_keys):
                            val = opt.get_attribute("value") or opt.inner_text().strip()
                            select_loc.first.select_option(value=val)
                            return True
            except Exception:
                pass

        # ── Custom dropdown (bootstrap / angular / etc.) ─────────────
        dropdown_triggers = [
            '[class*="dropdown"]', '[class*="division-filter"]',
            '[data-filter*="div"]', 'ul.nav li a',
        ]
        for sel in dropdown_triggers:
            try:
                items = loc.locator(sel).all()
                for item in items:
                    text = item.inner_text().strip().lower()
                    if any(k in text for k in division_keys):
                        item.click(timeout=3000)
                        return True
            except Exception:
                pass

        return False

    @staticmethod
    def _division_to_url_key(division: str) -> str:
        """Convert a division abbreviation to the PractiScore URL key."""
        mapping = {
            "CO": "carryoptics",
            "L":  "limited",
            "LO": "limitedoptics",
            "O":  "open",
            "PCC": "pcc",
            "REV": "revolver",
            "SS": "singlestack",
            "P":  "production",
        }
        return mapping.get(division.upper(), division.lower().replace(" ", ""))

    # ── Row reading ────────────────────────────────────────────────────

    def _read_competitor_row(
        self, loc, competitor_name: str, member_number: str
    ) -> Optional[MatchResult]:
        """
        After the division dropdown has been set, read the competitor's row
        from the results table inside the popover.
        """
        try:
            table_loc = loc.locator("table").last  # use the deepest/last results table
            header_cells = table_loc.locator("thead tr th").all()
            headers = [h.inner_text().strip().lower() for h in header_cells]

            data_rows = table_loc.locator("tbody tr").all()
            total = len(data_rows)

            for row in data_rows:
                cells = row.locator("td").all()
                if not cells:
                    continue
                row_text = " ".join(c.inner_text() for c in cells)
                name_match = competitor_name and competitor_name.lower() in row_text.lower()
                num_match = member_number and member_number.upper() in row_text.upper()
                if not (name_match or num_match):
                    continue

                return self._cells_to_result(headers, cells, total)

        except Exception as e:
            self.status(f"  Row read error: {e}")

        return None

    def _read_competitor_row_from_frame(
        self, frame: Frame, competitor_name: str, member_number: str
    ) -> Optional[MatchResult]:
        """Same as _read_competitor_row but for an iframe Frame."""
        try:
            from bs4 import BeautifulSoup
            html = frame.content()
            soup = BeautifulSoup(html, "html.parser")

            for table in soup.find_all("table"):
                headers = [th.get_text(strip=True).lower() for th in table.find_all("th")]
                if "place" not in headers and "name" not in headers:
                    continue

                data_rows = [r for r in table.find_all("tr") if r.find_all("td")]
                total = len(data_rows)

                for row in data_rows:
                    cells = row.find_all("td")
                    row_text = " ".join(c.get_text() for c in cells)
                    name_match = competitor_name and competitor_name.lower() in row_text.lower()
                    num_match = member_number and member_number.upper() in row_text.upper()
                    if not (name_match or num_match):
                        continue

                    # Convert bs4 cells to text list, re-use helper
                    cell_texts = [c.get_text(strip=True) for c in cells]

                    # Extract % from score_cell or any cell ending with %
                    pct = None
                    for c in reversed(cells):
                        val = c.get_text(strip=True)
                        if "%" in val:
                            try:
                                pct = float(val.replace("%", "").strip())
                                break
                            except ValueError:
                                pass

                    # Build result
                    r = MatchResult()
                    r.total_competitors = total
                    self._apply_headers_to_result(r, headers, cell_texts)
                    if pct is not None:
                        r.overall_pct = pct
                    return r

        except Exception as e:
            self.status(f"  Frame row read error: {e}")

        return None

    def _cells_to_result(self, headers: list[str], cells, total: int) -> MatchResult:
        """Map Playwright cell locators + headers into a MatchResult."""
        cell_texts = [c.inner_text().strip() for c in cells]
        r = MatchResult()
        r.total_competitors = total

        # Grab percentage from last cell containing %
        for text in reversed(cell_texts):
            if "%" in text:
                try:
                    r.overall_pct = float(text.replace("%", "").strip())
                    break
                except ValueError:
                    pass

        self._apply_headers_to_result(r, headers, cell_texts)
        return r

    def _apply_headers_to_result(
        self, r: MatchResult, headers: list[str], cell_texts: list[str]
    ):
        """Apply header-indexed cell values to a MatchResult."""
        for i, h in enumerate(headers):
            if i >= len(cell_texts):
                break
            val = cell_texts[i].strip()
            if not val:
                continue
            if h == "place":
                try:
                    r.place = int(val)
                except ValueError:
                    pass
            elif h == "name":
                pass  # we already matched on name
            elif h in ("div", "division"):
                r.division = val
            elif h == "class":
                r.class_ = val
            elif h in ("hf", "hit factor"):
                try:
                    r.hf = float(val)
                except ValueError:
                    pass

    # ── Debug helpers ──────────────────────────────────────────────────

    def _dump_page_structure(self, page: Page):
        """Log a summary of what's on the current page to help with debugging."""
        try:
            self.status(f"  URL: {page.url}")
            self.status(f"  Title: {page.title()}")
            buttons = page.locator("button").all()
            self.status(f"  Buttons ({len(buttons)}): " +
                        ", ".join(b.inner_text()[:20] for b in buttons[:6]))
            tables = page.locator("table").count()
            self.status(f"  Tables: {tables}")
            links = page.locator("a").count()
            self.status(f"  Links: {links}")
        except Exception:
            pass

    def get_page_snapshot(self) -> dict:
        page = self._page
        return {
            "url": page.url,
            "title": page.title(),
            "captured_json_count": len(self._captured_json),
            "captured_json_urls": [e["url"] for e in self._captured_json],
        }
