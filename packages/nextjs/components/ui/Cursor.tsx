type CursorProps = {
  x: number;
  y: number;
  label: string;
};

export const Cursor = ({ x, y, label }: CursorProps) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      pointerEvents: "none",
      transform: "translate(-2px, -2px)",
      filter: "drop-shadow(1px 1px 0 #000)",
      zIndex: 10000,
    }}
  >
    <svg width="16" height="20" viewBox="0 0 16 20">
      <path d="M1 1 L1 14 L4.5 11 L7 17 L9 16 L6.5 10 L11 10 Z" fill="#fff" stroke="#000" strokeWidth="1" />
    </svg>
    <div
      style={{
        marginLeft: 12,
        marginTop: -2,
        background: "var(--slop-accent)",
        color: "#fff",
        fontFamily: "var(--slop-font-body)",
        fontSize: 11,
        padding: "1px 5px",
        whiteSpace: "nowrap",
        display: "inline-block",
      }}
    >
      {label}
    </div>
  </div>
);

export default Cursor;
