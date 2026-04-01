"""
Chart generation for PractiScore match results using Plotly.
"""

import pandas as pd
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
from fetcher import MatchResult


def results_to_dataframe(results: list[MatchResult]) -> pd.DataFrame:
    rows = []
    for r in results:
        # Parse date
        parsed_date = None
        if r.date:
            for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m-%d-%Y", "%B %d, %Y", "%b %d, %Y", "%d/%m/%Y"):
                try:
                    parsed_date = pd.to_datetime(r.date, format=fmt)
                    break
                except ValueError:
                    pass
            if parsed_date is None:
                try:
                    parsed_date = pd.to_datetime(r.date, infer_datetime_format=True)
                except Exception:
                    pass

        rows.append(
            {
                "Match": r.match_name or "Unknown",
                "Date": parsed_date,
                "Date_str": r.date or "",
                "Division": r.division or "Unknown",
                "Class": r.class_ or "",
                "Overall %": r.overall_pct,
                "HF": r.hf,
                "Place": r.place,
                "Total": r.total_competitors,
                "URL": r.match_url,
            }
        )

    df = pd.DataFrame(rows)
    if not df.empty and "Date" in df.columns:
        df = df.sort_values("Date", na_position="last")
    return df


def chart_pct_over_time(df: pd.DataFrame) -> go.Figure:
    """Line chart of match % over time."""
    plot_df = df.dropna(subset=["Overall %"])
    if plot_df.empty:
        return _empty_fig("No percentage data available")

    # Use date if available, otherwise use sequential index
    use_date = plot_df["Date"].notna().any()
    x = plot_df["Date"] if use_date else plot_df.index
    x_label = "Date" if use_date else "Match #"

    fig = go.Figure()

    # One trace per division if multiple
    divisions = plot_df["Division"].unique()
    colors = px.colors.qualitative.Set2

    if len(divisions) > 1:
        for i, div in enumerate(divisions):
            sub = plot_df[plot_df["Division"] == div]
            xi = sub["Date"] if use_date else sub.index
            fig.add_trace(
                go.Scatter(
                    x=xi,
                    y=sub["Overall %"],
                    mode="lines+markers",
                    name=div,
                    line=dict(color=colors[i % len(colors)], width=2),
                    marker=dict(size=8),
                    hovertemplate=(
                        "<b>%{text}</b><br>"
                        "Score: %{y:.1f}%<br>"
                        "Place: " + sub["Place"].fillna("–").astype(str) + "<extra></extra>"
                    ),
                    text=sub["Match"],
                )
            )
    else:
        fig.add_trace(
            go.Scatter(
                x=x,
                y=plot_df["Overall %"],
                mode="lines+markers",
                name="Match %",
                line=dict(color="#2196F3", width=2),
                marker=dict(size=8, color="#2196F3"),
                hovertemplate=(
                    "<b>%{text}</b><br>"
                    "Score: %{y:.1f}%<br>"
                    "<extra></extra>"
                ),
                text=plot_df["Match"],
            )
        )

    # Add trend line
    if len(plot_df) >= 3:
        import numpy as np
        x_num = list(range(len(plot_df)))
        y_vals = plot_df["Overall %"].values
        z = np.polyfit(x_num, y_vals, 1)
        p = np.poly1d(z)
        trend_x = plot_df["Date"] if use_date else list(range(len(plot_df)))
        fig.add_trace(
            go.Scatter(
                x=trend_x,
                y=p(x_num),
                mode="lines",
                name="Trend",
                line=dict(color="rgba(255,87,34,0.6)", dash="dash", width=2),
                hoverinfo="skip",
            )
        )

    fig.update_layout(
        title="Match Performance Over Time",
        xaxis_title=x_label,
        yaxis_title="Overall Score %",
        yaxis=dict(range=[0, 105], ticksuffix="%"),
        hovermode="x unified",
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        plot_bgcolor="white",
        paper_bgcolor="white",
    )
    fig.update_xaxes(showgrid=True, gridcolor="#f0f0f0")
    fig.update_yaxes(showgrid=True, gridcolor="#f0f0f0")

    return fig


def chart_score_distribution(df: pd.DataFrame) -> go.Figure:
    """Histogram of match scores."""
    plot_df = df.dropna(subset=["Overall %"])
    if plot_df.empty:
        return _empty_fig("No percentage data available")

    fig = px.histogram(
        plot_df,
        x="Overall %",
        nbins=20,
        title="Score Distribution",
        labels={"Overall %": "Match Score %"},
        color_discrete_sequence=["#2196F3"],
    )
    fig.update_traces(marker_line_color="white", marker_line_width=1)
    fig.update_layout(
        xaxis=dict(range=[0, 105], ticksuffix="%"),
        yaxis_title="# Matches",
        plot_bgcolor="white",
        paper_bgcolor="white",
    )
    fig.update_xaxes(showgrid=True, gridcolor="#f0f0f0")
    fig.update_yaxes(showgrid=True, gridcolor="#f0f0f0")

    # Add mean line
    mean_pct = plot_df["Overall %"].mean()
    fig.add_vline(
        x=mean_pct,
        line_dash="dash",
        line_color="#FF5722",
        annotation_text=f"Avg: {mean_pct:.1f}%",
        annotation_position="top right",
    )
    return fig


def chart_placement(df: pd.DataFrame) -> go.Figure:
    """Chart showing place / total competitors over time."""
    plot_df = df.dropna(subset=["Place"])
    if plot_df.empty:
        return _empty_fig("No placement data available")

    use_date = plot_df["Date"].notna().any()
    x = plot_df["Date"] if use_date else plot_df.index

    has_total = plot_df["Total"].notna().any()

    fig = go.Figure()

    fig.add_trace(
        go.Scatter(
            x=x,
            y=plot_df["Place"],
            mode="lines+markers",
            name="Place",
            line=dict(color="#4CAF50", width=2),
            marker=dict(size=8),
            hovertemplate="<b>%{text}</b><br>Place: %{y}<extra></extra>",
            text=plot_df["Match"],
        )
    )

    if has_total:
        plot_df["Pct_Place"] = plot_df["Place"] / plot_df["Total"] * 100
        fig.add_trace(
            go.Scatter(
                x=x,
                y=plot_df["Pct_Place"],
                mode="lines+markers",
                name="Percentile (lower = better)",
                line=dict(color="#FF9800", dash="dot", width=2),
                marker=dict(size=6, symbol="diamond"),
                yaxis="y2",
                hovertemplate="<b>%{text}</b><br>Top %{y:.0f}%<extra></extra>",
                text=plot_df["Match"],
            )
        )
        fig.update_layout(
            yaxis2=dict(
                title="Percentile (lower = better)",
                overlaying="y",
                side="right",
                range=[0, 105],
                ticksuffix="%",
            )
        )

    fig.update_layout(
        title="Match Placement Over Time",
        xaxis_title="Date" if use_date else "Match #",
        yaxis=dict(title="Place", autorange="reversed"),
        hovermode="x unified",
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        plot_bgcolor="white",
        paper_bgcolor="white",
    )
    fig.update_xaxes(showgrid=True, gridcolor="#f0f0f0")
    fig.update_yaxes(showgrid=True, gridcolor="#f0f0f0")

    return fig


def chart_division_breakdown(df: pd.DataFrame) -> go.Figure:
    """Box plot of scores by division."""
    plot_df = df.dropna(subset=["Overall %"])
    if plot_df.empty or plot_df["Division"].nunique() < 2:
        return _empty_fig("Need multiple divisions to compare")

    fig = px.box(
        plot_df,
        x="Division",
        y="Overall %",
        color="Division",
        title="Score Distribution by Division",
        points="all",
        color_discrete_sequence=px.colors.qualitative.Set2,
    )
    fig.update_layout(
        yaxis=dict(range=[0, 105], ticksuffix="%"),
        plot_bgcolor="white",
        paper_bgcolor="white",
        showlegend=False,
    )
    return fig


def _empty_fig(msg: str) -> go.Figure:
    fig = go.Figure()
    fig.add_annotation(
        text=msg,
        xref="paper",
        yref="paper",
        x=0.5,
        y=0.5,
        showarrow=False,
        font=dict(size=16, color="#888"),
    )
    fig.update_layout(plot_bgcolor="white", paper_bgcolor="white")
    return fig
