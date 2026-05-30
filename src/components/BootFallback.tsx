export function BootFallback() {
  return (
    <div className="boot-shell" role="status">
      <div className="boot-splash">
        <svg
          className="boot-loader"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 56 56"
          width="112"
          height="112"
          role="img"
          aria-label="Loading"
        >
          <title>Loading</title>
          <desc>A diagonal stripe sweeps from corner to corner.</desc>
          <defs>
            <circle
              id="boot-loader-dot"
              r="2.4"
              fill="currentColor"
              opacity="0.12"
            />
            <circle id="boot-loader-lit" r="3.1" />
          </defs>
          <style>{`
            .boot-loader-lit {
              fill: currentColor;
              opacity: 0;
              animation: boot-loader-scan 1100ms cubic-bezier(0.25, 1, 0.5, 1) infinite both;
            }
            @keyframes boot-loader-scan {
              0% { opacity: 0; }
              8% { opacity: 1; }
              36% { opacity: 0.05; }
              100% { opacity: 0; }
            }
            @media (prefers-reduced-motion: reduce) {
              .boot-loader-lit {
                animation: none;
                opacity: 0.45;
              }
            }
            .d00 { animation-delay: -90ms; }
            .d01, .d10 { animation-delay: 2ms; }
            .d02, .d11, .d20 { animation-delay: 94ms; }
            .d03, .d12, .d21, .d30 { animation-delay: 185ms; }
            .d04, .d13, .d22, .d31, .d40 { animation-delay: 277ms; }
            .d14, .d23, .d32, .d41 { animation-delay: 369ms; }
            .d24, .d33, .d42 { animation-delay: 460ms; }
            .d34, .d43 { animation-delay: 552ms; }
            .d44 { animation-delay: 644ms; }
          `}</style>
          <use href="#boot-loader-dot" x="6" y="6" />
          <use href="#boot-loader-dot" x="17" y="6" />
          <use href="#boot-loader-dot" x="28" y="6" />
          <use href="#boot-loader-dot" x="39" y="6" />
          <use href="#boot-loader-dot" x="50" y="6" />
          <use href="#boot-loader-dot" x="6" y="17" />
          <use href="#boot-loader-dot" x="17" y="17" />
          <use href="#boot-loader-dot" x="28" y="17" />
          <use href="#boot-loader-dot" x="39" y="17" />
          <use href="#boot-loader-dot" x="50" y="17" />
          <use href="#boot-loader-dot" x="6" y="28" />
          <use href="#boot-loader-dot" x="17" y="28" />
          <use href="#boot-loader-dot" x="28" y="28" />
          <use href="#boot-loader-dot" x="39" y="28" />
          <use href="#boot-loader-dot" x="50" y="28" />
          <use href="#boot-loader-dot" x="6" y="39" />
          <use href="#boot-loader-dot" x="17" y="39" />
          <use href="#boot-loader-dot" x="28" y="39" />
          <use href="#boot-loader-dot" x="39" y="39" />
          <use href="#boot-loader-dot" x="50" y="39" />
          <use href="#boot-loader-dot" x="6" y="50" />
          <use href="#boot-loader-dot" x="17" y="50" />
          <use href="#boot-loader-dot" x="28" y="50" />
          <use href="#boot-loader-dot" x="39" y="50" />
          <use href="#boot-loader-dot" x="50" y="50" />
          <use
            className="boot-loader-lit d00"
            href="#boot-loader-lit"
            x="6"
            y="6"
          />
          <use
            className="boot-loader-lit d01"
            href="#boot-loader-lit"
            x="17"
            y="6"
          />
          <use
            className="boot-loader-lit d02"
            href="#boot-loader-lit"
            x="28"
            y="6"
          />
          <use
            className="boot-loader-lit d03"
            href="#boot-loader-lit"
            x="39"
            y="6"
          />
          <use
            className="boot-loader-lit d04"
            href="#boot-loader-lit"
            x="50"
            y="6"
          />
          <use
            className="boot-loader-lit d10"
            href="#boot-loader-lit"
            x="6"
            y="17"
          />
          <use
            className="boot-loader-lit d11"
            href="#boot-loader-lit"
            x="17"
            y="17"
          />
          <use
            className="boot-loader-lit d12"
            href="#boot-loader-lit"
            x="28"
            y="17"
          />
          <use
            className="boot-loader-lit d13"
            href="#boot-loader-lit"
            x="39"
            y="17"
          />
          <use
            className="boot-loader-lit d14"
            href="#boot-loader-lit"
            x="50"
            y="17"
          />
          <use
            className="boot-loader-lit d20"
            href="#boot-loader-lit"
            x="6"
            y="28"
          />
          <use
            className="boot-loader-lit d21"
            href="#boot-loader-lit"
            x="17"
            y="28"
          />
          <use
            className="boot-loader-lit d22"
            href="#boot-loader-lit"
            x="28"
            y="28"
          />
          <use
            className="boot-loader-lit d23"
            href="#boot-loader-lit"
            x="39"
            y="28"
          />
          <use
            className="boot-loader-lit d24"
            href="#boot-loader-lit"
            x="50"
            y="28"
          />
          <use
            className="boot-loader-lit d30"
            href="#boot-loader-lit"
            x="6"
            y="39"
          />
          <use
            className="boot-loader-lit d31"
            href="#boot-loader-lit"
            x="17"
            y="39"
          />
          <use
            className="boot-loader-lit d32"
            href="#boot-loader-lit"
            x="28"
            y="39"
          />
          <use
            className="boot-loader-lit d33"
            href="#boot-loader-lit"
            x="39"
            y="39"
          />
          <use
            className="boot-loader-lit d34"
            href="#boot-loader-lit"
            x="50"
            y="39"
          />
          <use
            className="boot-loader-lit d40"
            href="#boot-loader-lit"
            x="6"
            y="50"
          />
          <use
            className="boot-loader-lit d41"
            href="#boot-loader-lit"
            x="17"
            y="50"
          />
          <use
            className="boot-loader-lit d42"
            href="#boot-loader-lit"
            x="28"
            y="50"
          />
          <use
            className="boot-loader-lit d43"
            href="#boot-loader-lit"
            x="39"
            y="50"
          />
          <use
            className="boot-loader-lit d44"
            href="#boot-loader-lit"
            x="50"
            y="50"
          />
        </svg>
      </div>
    </div>
  );
}
