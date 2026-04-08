# Dashboard Analytics and KPI Display

> GitHub Issue: [#74](https://github.com/jbillay/kyc-agent/issues/74)
> Epic: Audit Trail & Reporting (#71)
> Size: M (3-5 days) | Priority: Medium

## Context

Compliance officers need operational visibility into the KYC process — how many cases are being processed, how long they take, where bottlenecks occur, and how risk is distributed across the portfolio. This story adds an analytics section to the existing dashboard view (`/dashboard`) with key performance metrics, charts, time period selection, and trend indicators.

Data is aggregated from the `cases` and `decision_events` tables via a `GET /api/v1/admin/system/stats` endpoint (defined in the architecture, section 7.2). No separate analytics table is needed for MVP — queries aggregate directly from operational tables, which is acceptable at expected case volumes (< 10,000 cases).

## Requirements

### Functional

1. Analytics panel displayed on the dashboard, above or alongside the existing Kanban board
2. KPI metric cards showing:
   - **Total cases** (in selected period)
   - **Average processing time** (created → completed, in hours/days)
   - **Cases pending review** (current count, not period-filtered)
   - **Screening hit rate** (percentage of cases with confirmed screening hits)
3. Charts:
   - **Cases by risk rating** — pie/donut chart (low, medium, high, very_high, unrated)
   - **Cases by state** — horizontal bar chart (CREATED, ENTITY_RESOLUTION, SCREENING, RISK_ASSESSMENT, PENDING_HUMAN_REVIEW, APPROVED, REJECTED, ESCALATED)
   - **Agent confidence distribution** — histogram showing average agent confidence across cases
4. Time period selector with presets:
   - Today
   - This week (Monday–Sunday)
   - This month
   - Last 30 days
   - Custom range (date picker)
5. Trend indicators on KPI cards:
   - Arrow up/down icon
   - Percentage change vs previous equivalent period (e.g., this week vs last week)
   - Green for positive trends, red for negative (context-dependent: more cases = neutral, faster processing = green)
6. Average time in each state breakdown (table or horizontal stacked bar):
   - How long cases spend in each pipeline state on average

### Non-Functional

- Stats endpoint responds within 1 second for up to 10,000 cases
- Charts render smoothly on standard hardware
- Analytics data refreshes on page load and when period selector changes (no polling)

## Technical Design

### Backend: Stats Endpoint

#### File: `backend/src/api/admin.js` (additions)

```javascript
// ─── GET /api/v1/admin/system/stats ─────────────
app.get(
  '/admin/system/stats',
  {
    preHandler: [app.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          period: {
            type: 'string',
            enum: ['today', 'this_week', 'this_month', 'last_30_days'],
          },
        },
      },
    },
  },
  async (request, reply) => {
    const { from, to, period } = request.query;
    const dateRange = resolveDateRange(from, to, period);
    const stats = await statsService.getSystemStats(dateRange);
    return reply.send(stats);
  }
);
```

#### File: `backend/src/services/stats-service.js`

```javascript
/**
 * Stats service — aggregates operational metrics from cases and events.
 *
 * @param {Object} deps
 * @param {import('pg').Pool} deps.db
 */
class StatsService {
  constructor({ db }) {
    this.db = db;
  }

  /**
   * Get system-wide statistics for a date range.
   *
   * @param {Object} dateRange
   * @param {Date} dateRange.from
   * @param {Date} dateRange.to
   * @param {Date} dateRange.previousFrom - start of previous equivalent period
   * @param {Date} dateRange.previousTo - end of previous equivalent period
   * @returns {Promise<Object>}
   */
  async getSystemStats(dateRange) {
    const { from, to, previousFrom, previousTo } = dateRange;

    const [
      currentMetrics,
      previousMetrics,
      casesByRisk,
      casesByState,
      avgTimeInState,
      confidenceDistribution,
      pendingReviewCount,
    ] = await Promise.all([
      this._getPeriodMetrics(from, to),
      this._getPeriodMetrics(previousFrom, previousTo),
      this._getCasesByRiskRating(from, to),
      this._getCasesByState(),
      this._getAvgTimeInState(from, to),
      this._getConfidenceDistribution(from, to),
      this._getPendingReviewCount(),
    ]);

    return {
      period: { from, to },
      kpis: {
        total_cases: {
          value: currentMetrics.total_cases,
          previous: previousMetrics.total_cases,
          trend: this._calcTrend(currentMetrics.total_cases, previousMetrics.total_cases),
        },
        avg_processing_time_hours: {
          value: currentMetrics.avg_processing_hours,
          previous: previousMetrics.avg_processing_hours,
          trend: this._calcTrend(
            previousMetrics.avg_processing_hours,
            currentMetrics.avg_processing_hours
          ), // Inverted: lower is better
        },
        pending_review: {
          value: pendingReviewCount,
          previous: null,
          trend: null,
        },
        screening_hit_rate: {
          value: currentMetrics.screening_hit_rate,
          previous: previousMetrics.screening_hit_rate,
          trend: this._calcTrend(currentMetrics.screening_hit_rate, previousMetrics.screening_hit_rate),
        },
      },
      charts: {
        cases_by_risk: casesByRisk,
        cases_by_state: casesByState,
        confidence_distribution: confidenceDistribution,
      },
      avg_time_in_state: avgTimeInState,
    };
  }

  async _getPeriodMetrics(from, to) {
    const result = await this.db.query(
      `SELECT
        COUNT(*) AS total_cases,
        AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 3600)
          FILTER (WHERE completed_at IS NOT NULL) AS avg_processing_hours,
        (COUNT(*) FILTER (WHERE risk_score IS NOT NULL AND risk_score > 0))::float
          / NULLIF(COUNT(*), 0) * 100 AS screening_hit_rate
      FROM cases
      WHERE created_at >= $1 AND created_at < $2`,
      [from, to]
    );
    return {
      total_cases: parseInt(result.rows[0].total_cases, 10),
      avg_processing_hours: parseFloat(result.rows[0].avg_processing_hours) || 0,
      screening_hit_rate: parseFloat(result.rows[0].screening_hit_rate) || 0,
    };
  }

  async _getCasesByRiskRating(from, to) {
    const result = await this.db.query(
      `SELECT COALESCE(risk_rating, 'unrated') AS rating, COUNT(*) AS count
       FROM cases
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY risk_rating
       ORDER BY count DESC`,
      [from, to]
    );
    return result.rows.map((r) => ({ label: r.rating, value: parseInt(r.count, 10) }));
  }

  async _getCasesByState() {
    const result = await this.db.query(
      `SELECT state, COUNT(*) AS count
       FROM cases
       GROUP BY state
       ORDER BY count DESC`
    );
    return result.rows.map((r) => ({ label: r.state, value: parseInt(r.count, 10) }));
  }

  async _getAvgTimeInState(from, to) {
    // Calculate average time cases spend in each state using decision_events transitions
    const result = await this.db.query(
      `WITH state_transitions AS (
        SELECT
          case_id,
          data->>'newState' AS state,
          timestamp AS entered_at,
          LEAD(timestamp) OVER (PARTITION BY case_id ORDER BY sequence_number) AS exited_at
        FROM decision_events
        WHERE event_type = 'state_change'
          AND case_id IN (SELECT id FROM cases WHERE created_at >= $1 AND created_at < $2)
      )
      SELECT
        state,
        AVG(EXTRACT(EPOCH FROM (COALESCE(exited_at, NOW()) - entered_at)) / 3600) AS avg_hours
      FROM state_transitions
      WHERE state IS NOT NULL
      GROUP BY state
      ORDER BY avg_hours DESC`,
      [from, to]
    );
    return result.rows.map((r) => ({
      state: r.state,
      avg_hours: parseFloat(r.avg_hours).toFixed(1),
    }));
  }

  async _getConfidenceDistribution(from, to) {
    const result = await this.db.query(
      `SELECT
        CASE
          WHEN confidence >= 90 THEN '90-100'
          WHEN confidence >= 80 THEN '80-89'
          WHEN confidence >= 70 THEN '70-79'
          WHEN confidence >= 60 THEN '60-69'
          WHEN confidence >= 50 THEN '50-59'
          ELSE 'Below 50'
        END AS bucket,
        COUNT(*) AS count
      FROM agent_results
      WHERE confidence IS NOT NULL
        AND started_at >= $1 AND started_at < $2
      GROUP BY bucket
      ORDER BY bucket DESC`,
      [from, to]
    );
    return result.rows.map((r) => ({ label: r.bucket, value: parseInt(r.count, 10) }));
  }

  async _getPendingReviewCount() {
    const result = await this.db.query(
      "SELECT COUNT(*) FROM cases WHERE state = 'PENDING_HUMAN_REVIEW'"
    );
    return parseInt(result.rows[0].count, 10);
  }

  _calcTrend(current, previous) {
    if (!previous || previous === 0) return null;
    const change = ((current - previous) / previous) * 100;
    return {
      direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
      percentage: Math.abs(change).toFixed(1),
    };
  }
}

module.exports = { StatsService };
```

### Date Range Resolution

```javascript
/**
 * Resolve date range from query params.
 * Returns { from, to, previousFrom, previousTo } for trend calculation.
 *
 * @param {string} [from]
 * @param {string} [to]
 * @param {string} [period]
 * @returns {Object}
 */
function resolveDateRange(from, to, period) {
  const now = new Date();

  if (from && to) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    const duration = toDate - fromDate;
    return {
      from: fromDate,
      to: toDate,
      previousFrom: new Date(fromDate - duration),
      previousTo: fromDate,
    };
  }

  switch (period) {
    case 'today': {
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 1);
      return { from: start, to: now, previousFrom: prevStart, previousTo: start };
    }
    case 'this_week': {
      const start = new Date(now);
      start.setDate(start.getDate() - start.getDay() + 1); // Monday
      start.setHours(0, 0, 0, 0);
      const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 7);
      return { from: start, to: now, previousFrom: prevStart, previousTo: start };
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { from: start, to: now, previousFrom: prevStart, previousTo: start };
    }
    case 'last_30_days':
    default: {
      const start = new Date(now); start.setDate(start.getDate() - 30);
      const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 30);
      return { from: start, to: now, previousFrom: prevStart, previousTo: start };
    }
  }
}
```

### Frontend: Analytics Components

#### File: `frontend/src/components/dashboard/AnalyticsPanel.vue`

Component structure:

```
AnalyticsPanel
├── PeriodSelector                  # Preset buttons + custom date range
├── KpiCards                        # 4 KPI metric cards with trend arrows
│   ├── KpiCard (Total Cases)
│   ├── KpiCard (Avg Processing Time)
│   ├── KpiCard (Pending Review)
│   └── KpiCard (Screening Hit Rate)
├── ChartRow                        # Charts side by side
│   ├── CasesByRiskChart            # Pie/donut chart
│   ├── CasesByStateChart           # Horizontal bar chart
│   └── ConfidenceChart             # Histogram
└── StateTimeTable                  # Avg time in each state
```

State management:

```javascript
const state = reactive({
  stats: null,
  loading: false,
  period: 'last_30_days',      // Active preset
  customFrom: null,
  customTo: null,
});

async function fetchStats() {
  state.loading = true;
  try {
    const params = state.period === 'custom'
      ? { from: state.customFrom, to: state.customTo }
      : { period: state.period };
    const { data } = await api.get('/admin/system/stats', { params });
    state.stats = data;
  } finally {
    state.loading = false;
  }
}

// Fetch on mount and when period changes
onMounted(fetchStats);
watch(() => state.period, fetchStats);
```

#### KPI Card Trend Display

```vue
<!-- KpiCard.vue template excerpt -->
<div class="kpi-card">
  <div class="kpi-label">{{ label }}</div>
  <div class="kpi-value">{{ formattedValue }}</div>
  <div v-if="trend" class="kpi-trend" :class="trendClass">
    <i :class="trend.direction === 'up' ? 'pi pi-arrow-up' : 'pi pi-arrow-down'" />
    <span>{{ trend.percentage }}%</span>
    <span class="vs-label">vs previous period</span>
  </div>
</div>
```

#### Chart Colors

| Risk Rating | Color |
|------------|-------|
| low | `#22c55e` (green) |
| medium | `#f59e0b` (amber) |
| high | `#ef4444` (red) |
| very_high | `#991b1b` (dark red) |
| unrated | `#9ca3af` (gray) |

### API Response Format

```json
{
  "period": {
    "from": "2026-03-08T00:00:00Z",
    "to": "2026-04-07T14:00:00Z"
  },
  "kpis": {
    "total_cases": {
      "value": 142,
      "previous": 128,
      "trend": { "direction": "up", "percentage": "10.9" }
    },
    "avg_processing_time_hours": {
      "value": 4.2,
      "previous": 5.1,
      "trend": { "direction": "up", "percentage": "17.6" }
    },
    "pending_review": {
      "value": 8,
      "previous": null,
      "trend": null
    },
    "screening_hit_rate": {
      "value": 12.5,
      "previous": 14.1,
      "trend": { "direction": "down", "percentage": "11.3" }
    }
  },
  "charts": {
    "cases_by_risk": [
      { "label": "low", "value": 65 },
      { "label": "medium", "value": 48 },
      { "label": "high", "value": 22 },
      { "label": "very_high", "value": 3 },
      { "label": "unrated", "value": 4 }
    ],
    "cases_by_state": [
      { "label": "APPROVED", "value": 98 },
      { "label": "PENDING_HUMAN_REVIEW", "value": 8 },
      { "label": "SCREENING", "value": 5 }
    ],
    "confidence_distribution": [
      { "label": "90-100", "value": 45 },
      { "label": "80-89", "value": 38 },
      { "label": "70-79", "value": 25 }
    ]
  },
  "avg_time_in_state": [
    { "state": "PENDING_HUMAN_REVIEW", "avg_hours": "12.4" },
    { "state": "SCREENING", "avg_hours": "0.8" },
    { "state": "ENTITY_RESOLUTION", "avg_hours": "0.3" }
  ]
}
```

## Acceptance Criteria

- [ ] Analytics panel visible on dashboard view, above or alongside Kanban board
- [ ] KPI cards show: total cases, avg processing time, pending review count, screening hit rate
- [ ] Pie/donut chart shows cases by risk rating with correct colors
- [ ] Bar chart shows cases by state
- [ ] Confidence distribution histogram displays correctly
- [ ] Average time in each state shown as table or chart
- [ ] Time period selector with presets: today, this week, this month, last 30 days
- [ ] Custom date range picker functional
- [ ] Charts and KPIs update when period changes
- [ ] Trend indicators show direction (up/down arrow) and percentage change vs previous period
- [ ] Trend colors: green for positive, red for negative (context-aware)
- [ ] `GET /api/v1/admin/system/stats` returns all metrics with period filtering
- [ ] Stats endpoint responds within 1 second for up to 10,000 cases
- [ ] Endpoint protected by authentication middleware
- [ ] Empty state handled gracefully (no cases in period shows zeros, not errors)

## Dependencies

- **Depends on**: #3 (Database — `cases` and `decision_events` tables), #4 (Backend scaffold), #39 (Dashboard view — existing Kanban to add analytics alongside), #67 (Auth — endpoint protection)
- **Blocks**: None

## Testing Strategy

### Backend

1. **Stats — basic metrics**: Create cases with known states and dates, request stats, verify KPI values match
2. **Stats — period filtering (today)**: Create cases today and yesterday, request `period=today`, verify only today's cases counted
3. **Stats — period filtering (this_week)**: Verify weekly boundaries correct
4. **Stats — period filtering (custom range)**: Request with from/to, verify bounded results
5. **Stats — trend calculation**: Create cases in current and previous period, verify trend direction and percentage
6. **Stats — cases by risk**: Create cases with different risk ratings, verify chart data
7. **Stats — cases by state**: Create cases in different states, verify chart data
8. **Stats — avg time in state**: Create cases with known state transitions, verify average calculation
9. **Stats — confidence distribution**: Create agent results with known confidence, verify histogram buckets
10. **Stats — empty period**: Request stats for period with no cases, verify zeros (not errors)
11. **Stats — pending review count**: Create pending review cases, verify count not affected by period filter

### Frontend

12. **Analytics panel rendering**: Mount dashboard, verify analytics section visible with all components
13. **KPI cards**: Verify all 4 KPI cards render with correct values
14. **Trend indicators**: Verify up/down arrows and percentages display correctly
15. **Period selector**: Select "this week", verify stats refresh with new data
16. **Custom range**: Select custom from/to dates, verify stats update
17. **Pie chart**: Verify risk rating chart renders with correct segments and colors
18. **Bar chart**: Verify state chart renders with correct bars
19. **Loading state**: Verify loading indicator while fetching stats
20. **Empty state**: No cases → verify cards show 0 and charts show empty state message
