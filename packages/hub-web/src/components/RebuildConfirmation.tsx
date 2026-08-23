import { useEffect, useRef } from "react";
import { AlertTriangle, DatabaseZap, X } from "lucide-react";
import styles from "../styles/hub.module.css";

export function RebuildConfirmation({
  open,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    confirmRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
      ) ?? []);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, open, pending]);

  if (!open) return null;

  return (
    <div className={styles.dialogBackdrop} role="presentation">
      <section
        aria-describedby="graph-rebuild-description"
        aria-labelledby="graph-rebuild-title"
        aria-modal="true"
        className={styles.confirmDialog}
        ref={dialogRef}
        role="dialog"
      >
        <div className={styles.confirmDialogHeader}>
          <span aria-hidden="true"><DatabaseZap /></span>
          <div>
            <p className={styles.panelEyebrow}>Explicit graph operation</p>
            <h2 id="graph-rebuild-title">Rebuild the code graph?</h2>
          </div>
          <button aria-label="Close rebuild confirmation" className={styles.iconButton} disabled={pending} onClick={onCancel} type="button"><X /></button>
        </div>
        <div className={styles.confirmDialogBody}>
          <AlertTriangle aria-hidden="true" />
          <p id="graph-rebuild-description">
            This replaces the derived graph from repository sources. It never stages or commits files, but it can take longer than an incremental refresh.
          </p>
        </div>
        <div className={styles.confirmDialogFacts}>
          <span><strong>Previous index</strong> remains trusted until publish</span>
          <span><strong>Repository</strong> stays read-only</span>
        </div>
        <div className={styles.confirmDialogActions}>
          <button className={styles.secondaryButton} disabled={pending} onClick={onCancel} type="button">Keep current graph</button>
          <button className={styles.dangerButton} disabled={pending} onClick={onConfirm} ref={confirmRef} type="button">
            {pending ? "Starting rebuild…" : "Start graph rebuild"}
          </button>
        </div>
      </section>
    </div>
  );
}
