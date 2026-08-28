---
name: Waker
description: A local-first, inspectable Codex workbench in the QoderWake 0.4.2 operating language.
colors:
  brand: '#0f8557'
  brand-hover: '#0b7048'
  brand-soft: '#e7f7f0'
  canvas: '#ffffff'
  surface: '#f5f8fb'
  surface-hover: '#edf2f7'
  text-strong: '#0f172a'
  text-body: '#334155'
  text-tertiary: '#475569'
  text-muted: '#52615a'
  text-placeholder: '#667085'
  border-default: '#cbd5e1'
  border-subtle: '#e2e8f0'
  success: '#25aa73'
  warning-surface: '#fef0c7'
  warning-text: '#cd6002'
  error-surface: '#fef3f2'
  error-text: '#b42318'
  dark-canvas: '#171a19'
  dark-surface: '#202422'
  dark-text: '#f3f5f4'
typography:
  display:
    fontFamily: 'DM Sans, -apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif'
    fontSize: '28px'
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: '-0.02em'
  headline:
    fontFamily: 'DM Sans, -apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif'
    fontSize: '24px'
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: '-0.02em'
  title:
    fontFamily: 'DM Sans, -apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif'
    fontSize: '17px'
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: 'DM Sans, -apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'DM Sans, -apple-system, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif'
    fontSize: '12px'
    fontWeight: 600
    lineHeight: 1.3
rounded:
  xs: '3px'
  sm: '4px'
  md: '6px'
  lg: '8px'
  xl: '12px'
  full: '9999px'
spacing:
  1: '4px'
  2: '8px'
  3: '12px'
  4: '16px'
  5: '24px'
  6: '32px'
  7: '40px'
  8: '48px'
  9: '64px'
components:
  button-primary:
    backgroundColor: '{colors.brand}'
    textColor: '{colors.canvas}'
    typography: '{typography.label}'
    rounded: '7px'
    padding: '0 13px'
    height: '34px'
  button-primary-hover:
    backgroundColor: '{colors.brand-hover}'
    textColor: '{colors.canvas}'
  button-secondary:
    backgroundColor: '{colors.canvas}'
    textColor: '{colors.text-body}'
    typography: '{typography.label}'
    rounded: '7px'
    padding: '0 13px'
    height: '34px'
  rail-item-active:
    backgroundColor: '{colors.brand-soft}'
    textColor: '{colors.brand}'
    rounded: '{rounded.xl}'
    width: '48px'
    height: '44px'
  input-default:
    backgroundColor: '{colors.canvas}'
    textColor: '{colors.text-strong}'
    typography: '{typography.body}'
    rounded: '7px'
    padding: '0 10px'
    height: '34px'
  card-waker:
    backgroundColor: '{colors.canvas}'
    textColor: '{colors.text-strong}'
    rounded: '{rounded.xl}'
    padding: '20px'
  chip-status:
    backgroundColor: '{colors.surface-hover}'
    textColor: '{colors.text-body}'
    typography: '{typography.label}'
    rounded: '{rounded.full}'
    padding: '3px 8px'
  tab-active:
    backgroundColor: '{colors.canvas}'
    textColor: '{colors.brand}'
    typography: '{typography.label}'
    padding: '10px 14px'
  panel-output:
    backgroundColor: '{colors.canvas}'
    textColor: '{colors.text-strong}'
    width: '390px'
  dialog-editor:
    backgroundColor: '{colors.canvas}'
    textColor: '{colors.text-strong}'
    rounded: '{rounded.xl}'
    padding: '22px'
    width: '560px'
  composer:
    backgroundColor: '{colors.canvas}'
    textColor: '{colors.text-strong}'
    typography: '{typography.body}'
    rounded: '{rounded.xl}'
    padding: '16px 16px 8px'
---

# Design System: Waker

## Overview

**Creative North Star: "The Local Operations Desk"**

Waker should feel like a calm desktop control surface for real local work: compact, inspectable, and continuously operational. Its visual authority is QoderWake 0.4.2, expressed through a persistent 64px icon rail, dense DM Sans typography, flat white and cool-gray work surfaces, and green state cues that make the active path legible without turning the interface into brand theater.

The interface exists to help a user manage Wakers, enter Chat, and move through tasks, projects, workflows, settings, and local knowledge without losing orientation. Information hierarchy comes from placement, spacing, borders, and restrained tonal changes. Ornament stays subordinate to state, provenance, and the work itself.

**Key Characteristics:**

- A 64px operational rail beside the active work surface in the first viewport.
- Compact desktop density built on a 4px spacing grid and 12–14px control typography.
- Flat white and cool-gray surfaces separated primarily by rules and tonal shifts.
- Green reserved for active navigation, primary action, focus, and healthy state.
- Local-first copy, explicit status, source traceability, and keyboard-safe modal behavior over decorative messaging.

## Colors

The palette is a cool neutral workspace with one restrained operational green and explicit semantic state colors.

### Primary

- **Operational Green** (`brand`): primary actions, active navigation, visible keyboard focus, and durable selection state.
- **Deep Operational Green** (`brand-hover`): hover and pressed emphasis for primary actions.
- **Mint State Wash** (`brand-soft`): selected rows, active rail items, and success-adjacent tonal backgrounds.

### Tertiary

- **Healthy Pulse** (`success`): running, connected, completed, and available states.
- **Amber Attention** (`warning-surface`, `warning-text`): running or initializing states that need notice but are not failures.
- **Local Failure Red** (`error-surface`, `error-text`): errors, failed state, and destructive action feedback.

### Neutral

- **Workbench White** (`canvas`): the main canvas, controls, cards, and content surfaces.
- **Cool Utility Gray** (`surface`): grouped controls, soft hover states, notices, and secondary work areas.
- **Slate Ink** (`text-strong`): page titles, primary labels, and high-priority content.
- **Working Slate** (`text-body`): controls and ordinary body copy.
- **Supporting Slate** (`text-tertiary`): explanatory copy and secondary labels that must retain comfortable contrast.
- **Muted Slate** (`text-muted`): helper text, metadata, timestamps, and de-emphasized content.
- **Placeholder Slate** (`text-placeholder`): placeholders and inactive utility details; never use it for essential instructions.
- **Structural Rule** (`border-default`) and **Quiet Rule** (`border-subtle`): control boundaries and panel division.
- **Night Workbench** (`dark-canvas`, `dark-surface`, `dark-text`): the system-preference dark equivalent; it keeps the same hierarchy rather than inventing a second identity.

**The Operational Green Rule.** Green communicates action or operational state; it does not become a decorative background field.

**The Neutral Canvas Rule.** Large surfaces stay white or cool gray so logs, messages, tasks, and citations remain the visual subject.

## Typography

**Display Font:** DM Sans with native system sans fallbacks  
**Body Font:** DM Sans with native system sans fallbacks  
**Label/Mono Font:** DM Sans for interface labels; the native monospace stack is reserved for paths, identifiers, code, and citations.

**Character:** The single-family system is contemporary, compact, and matter-of-fact. Weight and size shifts are narrow on purpose: this is a daily tool, not an editorial page.

### Hierarchy

- **Display** (`typography.display`): rare system-level titles and numerical summaries.
- **Headline** (`typography.headline`): 24px page titles and the chat welcome prompt.
- **Title** (`typography.title`): card titles, subsection headings, and concise panel headings.
- **Body** (`typography.body`): messages, descriptions, form values, and ordinary UI copy; explanatory lines generally stop near 68ch.
- **Label** (`typography.label`): compact control labels, status, navigation tooltips, and metadata; uppercase is reserved for categorical labels such as status and notebook group headings.

**The Compact Hierarchy Rule.** Establish hierarchy with weight, color, and spacing before adding a new type size.

## Layout

The shell fills the viewport and never allows the browser body to become the scrolling surface. At desktop widths, a fixed 64px icon rail anchors the left edge. Chat may add a 320px session column that can collapse to 44px, while the active work surface flexes to consume the remaining width. Thread content and its composer share a centered 1024px maximum width; the welcome composer is narrower at 672px.

Operational pages use a 30px × 36px × 48px page inset and a 68px minimum page header. Waker cards form an auto-filling grid with a 300px minimum card width. Knowledge uses a 220px notebook column beside the result area. The shared spacing scale is a strict 4px rhythm, with 8px and 12px gaps for controls, 16–24px for groups, and 32–64px for sections and canvas breathing room.

Management surfaces preserve that shell while choosing the smallest structure that makes state scannable. Memory uses a bordered 250px index beside a flexible detail pane. Automations use auto-fitting cards with a 280px minimum; workflows use a compact creation grid followed by horizontally scrollable state tabs and trace rows. Capabilities use the same tab grammar, with two equal permission cards. Session attachments, artifacts, and file changes live in a 390px right-side panel separated from the thread by one quiet rule.

At 900px and below, the outputs panel becomes a fixed overlay above the mobile-navigation zone, Memory stacks its index above the detail pane, and workflow creation becomes one column. At 760px and below, the rail becomes a fixed 62px bottom navigation bar, page padding contracts to 22px × 18px × 36px, page headers stack, card grids and permission layouts become single-column, and knowledge, workflow, and capability tabs may scroll horizontally. Critical actions remain reachable; density changes without removing core workflows.

**The Rail-First Rule.** Every primary desktop view begins beside the 64px navigation rail and preserves the user's current operational context.

## Elevation & Depth

The system is flat by default. Panel boundaries, white/gray tonal changes, and 1px rules carry most hierarchy. Compact buttons use an almost imperceptible low shadow; popovers use a multi-directional drop-shadow that behaves like a soft border plus ambient lift. Waker cards lift only on hover, and modal surfaces use the strongest shadow in the vocabulary.

### Shadow Vocabulary

- **Control Hairline** (`0 1px 2px rgba(16, 24, 40, 0.05)`): compact buttons and small raised controls.
- **Popover Edge** (`filter: var(--popover-shadow)`): menus, command surfaces, and floating panels; this is a filter group, never a box-shadow substitution.
- **Waker Hover Lift** (`0 6px 20px rgba(24, 63, 46, 0.07)`): Waker cards only, paired with a green-tinted border shift.
- **Modal Lift** (`0 8px 24px rgba(16, 24, 40, 0.16)`): dialogs that must clearly detach from the work surface.

**The Flat-by-Default Rule.** Resting surfaces use tone and borders; elevation appears only when layering or interaction requires it.

## Shapes

Corners are gently compact, not pill-heavy. Tiny icon controls and code labels use 3–4px corners; fields and buttons use 6–8px corners; cards, the composer, and floating surfaces use 12px corners. Full rounding is reserved for status chips, toggle tracks, circular state marks, and short suggestion pills. One-pixel borders define structure, while clipping is used only when content or state geometry requires it.

**The Radius Follows Scale Rule.** The larger the bounded surface, the larger its corner may be; do not put a 12px card radius on a 26px utility control.

## Components

### Buttons

- **Shape:** compact rectangles with gently curved 7px corners; header utilities use the tighter 4px token.
- **Primary:** Operational Green with white text, 34px height, and 13px horizontal padding; use for the next decisive action.
- **Hover / Focus:** darken to Deep Operational Green on hover, compress to 0.98 on press, and retain the global 2px green focus-visible outline. Disabled primary actions become a muted mint state with reduced opacity.
- **Secondary / Ghost:** secondary buttons are white with a structural border and hairline shadow; text buttons omit the container and turn green on hover.

### Chips

- **Style:** short status chips use full rounding, compact 3px × 8px padding, 11–12px semibold text, and a quiet tonal fill.
- **State:** neutral is cool gray; ready/completed/connected is mint and green; running/initializing is amber; failed/error is pale red.

### Cards / Containers

- **Corner Style:** 12px for Waker cards and the composer; 8–10px for result cards and notices.
- **Background:** Workbench White at rest, with Cool Utility Gray for grouped interior regions.
- **Shadow Strategy:** flat at rest; only interactive Waker cards gain the documented hover lift.
- **Border:** a single Quiet Rule, with a green-tinted hover border for Waker cards.
- **Internal Padding:** 20px for Waker cards; 16px is the common compact container inset.

### Inputs / Fields

- **Style:** white fill, 1px Structural Rule, 7px corners, 34px minimum height, and 10px horizontal padding.
- **Focus:** Operational Green border plus a restrained translucent 3px focus ring; the chat composer is the deliberate exception and remains visually stable on focus.
- **Error / Disabled:** error fields and messages use the failure tokens; disabled actions remain legible but drop to 48–60% opacity.

### Navigation

The desktop rail is 64px wide with 48px × 44px icon targets and 22px icons. Default items are muted slate, hover items gain a cool-gray fill, and the active item uses green on mint. Labels appear as dark tooltips beside the rail; on mobile the rail becomes bottom navigation, tooltips disappear, and icon targets remain at least 42px wide.

Within management views, capability and workflow tabs use a quiet bottom rule. The selected tab changes to Operational Green and adds a 2px green underline; inactive tabs remain muted but legible. On narrow screens, keep the tabs on one line and allow horizontal scrolling rather than compressing or wrapping labels.

### Operational Management Surfaces

Memory is a master-detail workspace: the cool-gray index gives selection context while the white detail pane carries content, snapshots, diffs, and rollback actions. Automation and permission cards stay flat, bounded by a single Quiet Rule, and expose status beside the title. Run history, human actions, attachments, artifacts, and file changes use compact ruled rows so identifiers, timestamps, provenance, and state can be scanned vertically.

Project management reuses that master-detail grammar: the index carries visibility, source, and read-only ownership; the detail pane exposes the server-controlled path and destructive impact before deletion. Knowledge pairs the notebook index with a connection header whose Connected, Read-only, Needs check, and Unbound states are textual as well as chromatic. File-import feedback stays inline with the selected notebook so partial success never looks like a completed operation.

The post-create Waker guide is an inline operational region, not a blocking modal. Its three next-step actions—Chat, Knowledge, and Project—stack on mobile, never claim configuration is complete, and may be dismissed without losing the newly created Waker.

The outputs panel is a contextual extension of Chat, not a separate destination. It stays 390px wide on desktop, uses a mint dashed upload target as its single high-emphasis affordance, and groups output types under terse 13px headings. When it overlays the work surface below 900px, it must still stop above the 62px bottom navigation.

Completed Chat answers are reading surfaces rather than generic bubbles. Long user or assistant content folds behind a deterministic text summary whose hidden descendants leave the focus tree. Fenced code keeps a compact language bar with explicit copy success/failure and plain-text download actions. Thinking stays quiet and collapsed; plans and tools form one expandable process group whose running, completed, failed, or cancelled state is always written in text. Structured knowledge sources disclose notebook, document, chunk, retrieval mode, score, line range, and escaped excerpt without exposing host paths. The latest answer and file-change turns provide a direct route into the current Session Outputs panel.

Pending Composer attachments form one horizontally scrollable strip above the input: 32px image thumbnails or file marks, a compact ready/error line, and one remove action. Drag state strengthens the existing border and mint wash rather than introducing a new drop-zone surface. The strip persists across the Welcome-to-Thread transition and clears only after a completed turn.

Attachment previews are protected-focus dialogs. Text and JSON remain plain escaped text, capped at 64 KB; images use their natural aspect ratio inside a bounded neutral stage. The Outputs panel reports batch upload results per file, keeps download available for non-preview types, and never represents a manually registered Artifact as model-generated output.

### Dialogs

Dialogs use a dim neutral backdrop, a white 12px-rounded surface, and the documented modal lift. The shared dialog-focus behavior moves focus to an explicit autofocus target or the first enabled control, traps Tab and Shift+Tab inside the dialog, closes on Escape or a backdrop press when the action is not busy, and restores focus to the invoking control after close. Every modal surface exposes `role="dialog"`, `aria-modal="true"`, a labelled title, and a programmatically focusable container fallback.

**The Modal Continuity Rule.** Opening a dialog must never lose the user's keyboard position; focus enters, stays within, and returns to the control that launched it.

### Composer

The composer is the signature working surface: a 12px rounded, 1px bordered container whose text area and toolbar read as one object. It is centered with the thread column, keeps a 48px minimum input height, and uses small 26px actions so message content remains dominant.

## Do's and Don'ts

### Do:

- **Do** preserve the 64px desktop rail and its 62px mobile bottom-navigation transformation.
- **Do** use Operational Green only for primary action, selection, focus, or healthy operational state.
- **Do** keep interaction text concise and Chinese-first while leaving code, paths, model names, and technical identifiers in their conventional English form.
- **Do** provide visible focus, keyboard reachability, reduced-motion behavior, honest empty/error/loading states, and traceable local-source cues.
- **Do** use Supporting Slate for essential helper copy and reserve Placeholder Slate for truly nonessential hints.
- **Do** keep Memory, run history, capabilities, and session outputs visually connected through shared ruled rows, status chips, compact tabs, and flat bounded containers.
- **Do** apply the shared focus lifecycle to every modal: initial focus, Tab containment, Escape dismissal, and trigger restoration.
- **Do** record the source and license of every shipping raster asset; the current shipped web surface uses SVG marks and WOFF2 fonts and contains no raster asset.

### Don't:

- **Don't** reintroduce Fleet's visual identity, marketing-style hero composition, billing/quota decoration, or unsupported cloud-integration theater.
- **Don't** replace the cool neutral canvas with large green fields, gradients, glass effects, or decorative elevation.
- **Don't** invent token names outside the shared `--bg-*`, `--text-*`, `--border-*`, `--radius-*`, `--space-*`, `--duration-*`, and documented shadow vocabulary.
- **Don't** use `--popover-shadow` as `box-shadow`; it is a `filter: drop-shadow(...)` group.
- **Don't** hide product state: running, connected, degraded, failed, empty, disabled, and source provenance must remain explicit.
- **Don't** let a 390px contextual panel shrink the thread into an unusable column; switch it to the bounded overlay behavior at 900px.
- **Don't** place essential explanatory text in placeholder or disabled colors, especially on cool-gray surfaces.
