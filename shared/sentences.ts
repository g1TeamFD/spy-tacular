export type SentenceChallenge = {
  id: string;
  template: string;
  answer: string;
  keywords: string[];
};

export const SENTENCE_CHALLENGES: SentenceChallenge[] = [
  {
    id: '1',
    template: 'We must _____ our planet for future generations.',
    answer: 'protect',
    keywords: ['protect', 'preserve', 'care', 'sustain']
  },
  {
    id: '2',
    template: 'Together we can create a more _____ world.',
    answer: 'sustainable',
    keywords: ['sustainable', 'green', 'balanced', 'harmonious']
  },
  {
    id: '3',
    template: 'Every person deserves _____ and dignity.',
    answer: 'respect',
    keywords: ['respect', 'love', 'care', 'equality']
  }
];

export const getSentenceTemplate = (sentenceId: string): string =>
  SENTENCE_CHALLENGES.find(s => s.id === sentenceId)?.template ?? '';
