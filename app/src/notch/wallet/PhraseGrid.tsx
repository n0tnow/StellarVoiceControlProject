/**
 * Numbered recovery-phrase grid (task W10b).
 *
 * The phrase is shown once. This component is deliberately presentational and
 * never persists the words: it renders the array it is handed and nothing else.
 */
export interface PhraseGridProps {
  words: readonly string[];
}

export function PhraseGrid({ words }: PhraseGridProps) {
  return (
    <ol className="grid grid-cols-3 gap-1" aria-label="Recovery phrase">
      {words.map((word, index) => (
        <li key={`${index}-${word}`} className="wallet-key">
          <span className="wallet-key-label">{index + 1}</span>
          <code className="wallet-key-value selectable">{word}</code>
        </li>
      ))}
    </ol>
  );
}
