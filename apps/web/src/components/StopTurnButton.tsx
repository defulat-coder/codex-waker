export function StopTurnButton({ running, onStop }: { running: boolean; onStop: () => void }) {
  return (
    <button
      type="button"
      className="turn-stop-button"
      aria-label="停止生成"
      disabled={!running}
      onClick={onStop}
    >
      {running ? '停止' : '已停止'}
    </button>
  );
}
