// src/utils/lyrics/chineseConverter.ts
// Converts lyrics and translations from Simplified Chinese to Traditional Chinese (Taiwan standard)
// using opencc-js.

import * as OpenCC from 'opencc-js';
import type { LyricData, Line, Word, LyricAlternateText, LyricBackgroundVocal } from '../../types';

let s2tConverter: ((text: string) => string) | null = null;

export const getS2TConverter = (): ((text: string) => string) => {
    if (!s2tConverter) {
        s2tConverter = OpenCC.Converter({ from: 'cn', to: 'tw' });
    }
    return s2tConverter;
};

export const convertChineseTextToTraditional = (text: string): string => {
    if (!text) return text;
    return getS2TConverter()(text);
};

export const convertLyricsToTraditional = (lyrics: LyricData): LyricData => {
    const conv = getS2TConverter();

    const convertWord = (w: Word): Word => ({
        ...w,
        text: conv(w.text),
        syllables: w.syllables?.map(s => ({
            ...s,
            text: conv(s.text),
        })),
    });

    const convertBackgroundVocal = (bg: LyricBackgroundVocal): LyricBackgroundVocal => ({
        ...bg,
        text: conv(bg.text),
        words: bg.words ? bg.words.map(convertWord) : bg.words,
    });

    const convertAlternateText = (alt: LyricAlternateText): LyricAlternateText => ({
        ...alt,
        text: conv(alt.text),
        syllables: alt.syllables?.map(s => ({
            ...s,
            text: conv(s.text),
        })),
    });

    const convertLine = (line: Line): Line => {
        const fullText = conv(line.fullText);
        const translation = line.translation ? conv(line.translation) : line.translation;
        const words = line.words ? line.words.map(convertWord) : line.words;
        const backgroundVocal = line.backgroundVocal ? convertBackgroundVocal(line.backgroundVocal) : line.backgroundVocal;
        const backgroundVocals = line.backgroundVocals ? line.backgroundVocals.map(convertBackgroundVocal) : line.backgroundVocals;
        const alternateTexts = line.alternateTexts ? line.alternateTexts.map(convertAlternateText) : line.alternateTexts;
        const wordSegments = line.wordSegments ? line.wordSegments.map(s => conv(s)) : line.wordSegments;
        const autoWordSegments = line.autoWordSegments ? line.autoWordSegments.map(s => conv(s)) : line.autoWordSegments;

        return {
            ...line,
            fullText,
            translation,
            words,
            backgroundVocal,
            backgroundVocals,
            alternateTexts,
            wordSegments,
            autoWordSegments,
        };
    };

    return {
        ...lyrics,
        title: lyrics.title ? conv(lyrics.title) : lyrics.title,
        artist: lyrics.artist ? conv(lyrics.artist) : lyrics.artist,
        lines: lyrics.lines.map(convertLine),
    };
};
