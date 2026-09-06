// Thin wrapper around the vendored Chart.js so every page shares one theme
// and one lifecycle (destroy before re-render on auto-refresh).

const THEME = {
  text: '#9AA3AC',
  grid: '#363C41',
  accent: '#F2A900',
  accentFill: 'rgba(242,169,0,.16)',
  warn: '#E8792B',
  panel: '#212528',
  palette: ['#F2A900', '#E8792B', '#5FB13A', '#5B8DEF', '#B076D1', '#D6392E', '#7E8A93', '#E8C547'],
};

let themed = false;

function ensureTheme() {
  if (themed || !globalThis.Chart) return;
  const { Chart } = globalThis;
  Chart.defaults.color = THEME.text;
  Chart.defaults.borderColor = THEME.grid;
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.animation = { duration: 300 };
  Chart.defaults.responsive = true;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  themed = true;
}

export const chartTheme = THEME;
export const chartsAvailable = () => Boolean(globalThis.Chart);

// Keeps track of charts by canvas id so re-rendering a page replaces them.
const registry = new Map();

export function mountChart(canvasId, config) {
  ensureTheme();
  const canvas = document.getElementById(canvasId);
  if (!canvas || !globalThis.Chart) return null;
  registry.get(canvasId)?.destroy();
  const chart = new globalThis.Chart(canvas, config);
  registry.set(canvasId, chart);
  return chart;
}

export function destroyCharts() {
  registry.forEach((chart) => chart.destroy());
  registry.clear();
}

export const money = (value) => `$${Number(value).toLocaleString('en-US')}`;
export const integer = (value) => Number(value).toLocaleString('en-US');
