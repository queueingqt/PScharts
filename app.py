"""
PractiScore Score Tracker
Streamlit app to log into PractiScore, fetch match results for a USPSA member
number, and display interactive charts.
"""

from typing import Optional

import pandas as pd
import streamlit as st

from fetcher import PractiScoreFetcher, MatchResult
from charts import (
    results_to_dataframe,
    chart_pct_over_time,
    chart_score_distribution,
    chart_placement,
    chart_division_breakdown,
)

# ── Page config ────────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="PractiScore Tracker",
    page_icon="🎯",
    layout="wide",
)

# ── Session state defaults ─────────────────────────────────────────────────────
for key, default in [
    ("results", None),
    ("log", []),
    ("error", None),
]:
    if key not in st.session_state:
        st.session_state[key] = default


# ── Sidebar ────────────────────────────────────────────────────────────────────
with st.sidebar:
    st.title("🎯 PractiScore Tracker")
    st.markdown("Fetch and chart your USPSA match scores.")

    st.subheader("PractiScore Login")
    username = st.text_input("Email / Username", placeholder="you@email.com")
    password = st.text_input("Password", type="password")

    st.subheader("Competitor")
    competitor_name = st.text_input(
        "Name (as shown on results)",
        placeholder="e.g. Evànger, Alexis",
        help="Your last name, first name as it appears in PractiScore result tables.",
    )
    member_number = st.text_input(
        "USPSA Member Number",
        placeholder="e.g. A12345 or TY12345",
        help="Used as a fallback if name lookup fails.",
    )

    headless = st.checkbox("Headless browser (uncheck to see browser)", value=True)

    fetch_btn = st.button("Fetch Results", type="primary", use_container_width=True)

    if st.button("Clear Results", use_container_width=True):
        st.session_state.results = None
        st.session_state.log = []
        st.session_state.error = None
        st.rerun()

    st.divider()
    st.markdown(
        """
**How it works**
1. Enter your PractiScore login credentials.
2. Enter your name exactly as it appears on result sheets.
3. Click **Fetch Results**.
4. The app opens practiscore.com/associate/step2, finds each match
   you competed in, detects which division you shot, and pulls the
   division-specific place and match % for each match.

**Troubleshooting**
- Uncheck *Headless browser* to watch the browser live.
- Name must match the result table (e.g. "Smith, John").
"""
    )


# ── Fetch logic (synchronous — runs in main thread with st.status) ─────────────
def run_fetcher(username: str, password: str, member_number: str, competitor_name: str, headless: bool, write_fn):
    """Run the fetcher synchronously, calling write_fn() for live status lines."""
    log = []
    results = []
    error = None

    def status(msg: str):
        log.append(msg)
        write_fn(msg)

    try:
        with PractiScoreFetcher(headless=headless, status_callback=status) as fetcher:
            status("Opening browser…")

            if username and password:
                ok = fetcher.login(username, password)
                if ok:
                    status("Logged in successfully.")
                else:
                    status("Login may have failed — continuing anyway.")
            else:
                status("No credentials — searching without login.")

            status(f"Searching for: {competitor_name or member_number}")
            results = fetcher.get_results_for_member(member_number, competitor_name)

            if not results:
                snap = fetcher.get_page_snapshot()
                status(f"Last page: {snap['url']}")
                status(f"Captured JSON responses: {snap['captured_json_count']}")
                for u in snap["captured_json_urls"][:10]:
                    status(f"  · {u}")

    except Exception as e:
        error = str(e)
        status(f"Error: {e}")

    return results, log, error


if fetch_btn:
    if not member_number and not competitor_name:
        st.error("Please enter your name or USPSA member number.")
    else:
        st.session_state.results = None
        st.session_state.log = []
        st.session_state.error = None

        with st.status("Fetching results…", expanded=True) as status_box:
            results, log, error = run_fetcher(
                username, password, member_number, competitor_name, headless,
                write_fn=st.write,
            )
            if error:
                status_box.update(label="Error during fetch", state="error")
            elif results:
                status_box.update(label=f"Done — {len(results)} match(es) found", state="complete")
            else:
                status_box.update(label="No results found", state="error")

        st.session_state.results = results
        st.session_state.log = log
        st.session_state.error = error
        st.rerun()


# ── Results display ─────────────────────────────────────────────────────────────
if st.session_state.error:
    st.error(f"Error: {st.session_state.error}")

if st.session_state.log:
    with st.expander(
        "Fetch Log",
        expanded=not st.session_state.results,
    ):
        st.code("\n".join(st.session_state.log), language=None)

results = st.session_state.results  # type: Optional[list]

if results is not None:
    if not results:
        st.warning(
            "No results were found. Possible reasons:\n"
            "- Login failed (check credentials)\n"
            "- PractiScore changed its site layout\n"
            "- The member number was not recognized\n\n"
            "Try unchecking **Headless browser** to watch the fetcher live."
        )
    else:
        df = results_to_dataframe(results)

        col1, col2, col3, col4 = st.columns(4)
        with col1:
            st.metric("Matches Found", len(results))
        with col2:
            avg = df["Overall %"].mean()
            st.metric("Avg Score %", f"{avg:.1f}%" if pd.notna(avg) else "—")
        with col3:
            best = df["Overall %"].max()
            st.metric("Best Score %", f"{best:.1f}%" if pd.notna(best) else "—")
        with col4:
            divisions = df["Division"].dropna().unique()
            st.metric("Divisions", ", ".join(d for d in divisions if d and d != "Unknown") or "—")

        st.divider()

        tab_time, tab_dist, tab_place, tab_div, tab_data = st.tabs(
            ["📈 Over Time", "📊 Distribution", "🏆 Placement", "🔀 By Division", "📋 Raw Data"]
        )

        with tab_time:
            st.plotly_chart(chart_pct_over_time(df), use_container_width=True)

        with tab_dist:
            st.plotly_chart(chart_score_distribution(df), use_container_width=True)

        with tab_place:
            st.plotly_chart(chart_placement(df), use_container_width=True)

        with tab_div:
            if df["Division"].nunique() > 1:
                st.plotly_chart(chart_division_breakdown(df), use_container_width=True)
            else:
                st.info("Shoot in multiple divisions to see this chart.")

        with tab_data:
            display_cols = [
                c for c in ["Match", "Date_str", "Division", "Class", "Overall %", "HF", "Place", "Total", "URL"]
                if c in df.columns
            ]
            display_df = df[display_cols].rename(columns={"Date_str": "Date"})
            st.dataframe(display_df, use_container_width=True, hide_index=True)
            csv = display_df.to_csv(index=False)
            st.download_button(
                "Download CSV",
                data=csv,
                file_name=f"practiscore_{member_number or competitor_name.replace(', ', '_')}.csv",
                mime="text/csv",
            )

elif results is None:
    st.markdown(
        """
## Welcome to PractiScore Tracker

Enter your credentials and USPSA member number in the sidebar, then click **Fetch Results**.

### What you'll get
| Chart | Description |
|-------|-------------|
| 📈 Over Time | Your match % scores plotted chronologically with a trend line |
| 📊 Distribution | Histogram of all your match scores |
| 🏆 Placement | Your finish placement (and percentile) at each match |
| 🔀 By Division | Score distribution broken down by division |
| 📋 Raw Data | Full table with CSV export |

### Notes
- PractiScore has no public API — this app uses browser automation.
- Login is required to access your full score history.
- The first fetch may take 20–30 seconds.
"""
    )
