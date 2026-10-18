// Stage rig over the album-color backdrop: a truss across the top with three spotlight
// cans on yokes, each throwing a soft beam toward its deck.

const PIPE_Y = 18;
/** Lamps hang a little smaller so they clear the top of the console. */
const LAMP_SCALE = 0.78;
const lampSize = (x: number) => `translate(${x} ${PIPE_Y}) scale(${LAMP_SCALE}) translate(${-x} ${-PIPE_Y})`;

const LAMPS = [
  { x: 250, aim: -27, delay: 0 }, // over record A, aimed at deck A
  { x: 960, aim: 0, delay: -3 }, // center, aimed at the mixer
  { x: 1670, aim: 27, delay: -6 }, // over record B, aimed at deck B
];

export function Stage() {
  return (
    <svg className="stage" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff8dc" stopOpacity="0.5" />
          <stop offset="0.35" stopColor="#fff8dc" stopOpacity="0.17" />
          <stop offset="1" stopColor="#fff8dc" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="beam-core" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.5" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.06" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="can" x1="0" x2="1">
          <stop offset="0" stopColor="#0d0d10" />
          <stop offset="0.35" stopColor="#34343c" />
          <stop offset="0.55" stopColor="#1c1c21" />
          <stop offset="1" stopColor="#0a0a0c" />
        </linearGradient>
        <linearGradient id="pipe" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3b3b44" />
          <stop offset="0.5" stopColor="#15151a" />
          <stop offset="1" stopColor="#08080a" />
        </linearGradient>
        <radialGradient id="lens">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.35" stopColor="#fffbe0" />
          <stop offset="0.75" stopColor="#ffe45c" />
          <stop offset="1" stopColor="#f5b800" />
        </radialGradient>
        <radialGradient id="bloom">
          <stop offset="0" stopColor="#fff6c8" stopOpacity="0.85" />
          <stop offset="0.4" stopColor="#ffe98a" stopOpacity="0.3" />
          <stop offset="1" stopColor="#ffe98a" stopOpacity="0" />
        </radialGradient>
        <filter id="beam-blur" x="-40%" y="-5%" width="180%" height="115%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
      </defs>

      {/* Beams first so the lamp bodies sit on top of them. */}
      {LAMPS.map(({ x, aim, delay }) => (
        <g key={`beam${x}`} transform={`${lampSize(x)} rotate(${aim} ${x} ${PIPE_Y + 20})`}>
          <g className="sway" style={{ transformOrigin: `${x}px ${PIPE_Y + 20}px`, animationDelay: `${delay}s` }}>
            <polygon
              points={`${x - 34},118 ${x + 34},118 ${x + 330},1250 ${x - 330},1250`}
              fill="url(#beam)"
              filter="url(#beam-blur)"
              style={{ mixBlendMode: 'screen' }}
            />
            <polygon
              points={`${x - 16},118 ${x + 16},118 ${x + 120},1100 ${x - 120},1100`}
              fill="url(#beam-core)"
              filter="url(#beam-blur)"
              style={{ mixBlendMode: 'screen' }}
            />
          </g>
        </g>
      ))}

      {/* Box truss: two pipes with diagonal lacing. */}
      <g>
        <rect x="-10" y={PIPE_Y - 16} width="1940" height="7" rx="3.5" fill="url(#pipe)" />
        <rect x="-10" y={PIPE_Y} width="1940" height="9" rx="4.5" fill="url(#pipe)" />
        {Array.from({ length: 49 }, (_, i) => (
          <line
            key={i}
            x1={i * 40}
            y1={PIPE_Y - 10}
            x2={i * 40 + 20}
            y2={PIPE_Y + 2}
            stroke="#1e1e24"
            strokeWidth="2.5"
          />
        ))}
      </g>

      {LAMPS.map(({ x, aim, delay }) => (
        <g key={x}>
          {/* Clamp on the pipe */}
          <rect x={x - 9} y={PIPE_Y - 4} width="18" height="18" rx="3" fill="#232329" />
          <g transform={`${lampSize(x)} rotate(${aim} ${x} ${PIPE_Y + 20})`}>
            <g className="sway" style={{ transformOrigin: `${x}px ${PIPE_Y + 20}px`, animationDelay: `${delay}s` }}>
              {/* Yoke */}
              <path
                d={`M ${x - 44} 88 L ${x - 44} ${PIPE_Y + 26} Q ${x - 44} ${PIPE_Y + 18} ${x - 36} ${PIPE_Y + 18} L ${x + 36} ${PIPE_Y + 18} Q ${x + 44} ${PIPE_Y + 18} ${x + 44} ${PIPE_Y + 26} L ${x + 44} 88`}
                fill="none"
                stroke="#1a1a1f"
                strokeWidth="7"
                strokeLinecap="round"
              />
              {/* Can */}
              <path
                d={`M ${x - 32} 44 Q ${x - 32} 36 ${x - 24} 36 L ${x + 24} 36 Q ${x + 32} 36 ${x + 32} 44 L ${x + 38} 112 L ${x - 38} 112 Z`}
                fill="url(#can)"
              />
              <rect x={x - 40} y="108" width="80" height="10" rx="5" fill="#09090b" />
              {/* Lens and bloom */}
              <circle cx={x} cy="120" r="78" fill="url(#bloom)" className="bloom" />
              <ellipse cx={x} cy="116" rx="31" ry="7" fill="url(#lens)" />
            </g>
          </g>
        </g>
      ))}
    </svg>
  );
}
