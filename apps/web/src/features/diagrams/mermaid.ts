/**
 * Mermaid is large, so it is loaded only when the first diagram is shown. Renders run
 * one at a time (Mermaid keeps global state while rendering).
 */
import type MermaidModule from 'mermaid';

type Mermaid = typeof MermaidModule;

let loading: Promise<Mermaid> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

function load(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default);
  return loading;
}

/** Branch colours: soft fills with dark text in light mode, deep fills with light text in dark mode. */
const BRANCHES = {
  light: ['#dbe7fb', '#dcf1df', '#fbe6cf', '#ebe0fb', '#fbdcdc', '#d6f0ee'],
  dark: ['#26405f', '#27452d', '#5a3d1c', '#40305c', '#5a2a2a', '#1f4a47'],
};

/** Theme variables matching the app's palette, readable in both themes. */
function themeVariables(dark: boolean) {
  const fills = dark ? BRANCHES.dark : BRANCHES.light;
  const text = dark ? '#f1f0ec' : '#1f1d1a';
  const vars: Record<string, string | boolean> = {
    darkMode: dark,
    background: dark ? '#1c1c1b' : '#ffffff',
    fontSize: '15px',
    primaryColor: dark ? '#2d2b28' : '#f3f1ec',
    primaryTextColor: text,
    primaryBorderColor: dark ? '#6f6a62' : '#a39e94',
    secondaryColor: fills[0]!,
    tertiaryColor: fills[2]!,
    lineColor: dark ? '#8a857c' : '#8a857c',
    textColor: text,
    edgeLabelBackground: dark ? '#1c1c1b' : '#ffffff',
  };
  for (let i = 0; i < 12; i++) {
    vars[`cScale${i}`] = fills[i % fills.length]!;
    vars[`cScaleLabel${i}`] = text;
  }
  // The mind map's central node uses the first "git" colour.
  vars.git0 = dark ? '#3d3a35' : '#ece6da';
  vars.gitBranchLabel0 = text;
  return vars;
}

/** Renders Mermaid source to an SVG string in the app's current theme. */
export function renderDiagram(source: string, dark: boolean): Promise<string> {
  const run = async () => {
    const mermaid = await load();
    mermaid.initialize({
      startOnLoad: false,
      // Claude's source may echo PDF text: no scripts, links or click handlers.
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: themeVariables(dark),
      fontFamily: 'Inter Variable, system-ui, sans-serif',
      // Plain SVG text instead of HTML labels, so the diagram can be exported as PNG.
      htmlLabels: false,
      flowchart: { htmlLabels: false, useMaxWidth: true },
      mindmap: { useMaxWidth: true },
    });
    const { svg } = await mermaid.render(`pca-diagram-${++counter}`, source);
    return svg;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
