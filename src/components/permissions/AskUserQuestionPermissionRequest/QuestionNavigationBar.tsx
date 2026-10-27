import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import React, { useMemo } from 'react';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { stringWidth } from '../../../ink/stringWidth.js';
import { Box, Text } from '../../../ink.js';
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js';
import { truncateToWidth } from '../../../utils/format.js';
import { isScreenReaderEnabled } from '../../../utils/screenReader.js';
import { jsonStringify } from '../../../utils/slowOperations.js';
type Props = {
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  hideSubmitTab?: boolean;
};
export function QuestionNavigationBar(t0) {
  const $ = _c(51);
  const {
    questions,
    currentQuestionIndex,
    answers,
    hideSubmitTab: t1
  } = t0;
  const hideSubmitTab = t1 === undefined ? false : t1;
  const {
    columns
  } = useTerminalSize();
  const srEnabled = isScreenReaderEnabled();
  let t2;
  if ($[0] !== columns || $[1] !== currentQuestionIndex || $[2] !== hideSubmitTab || $[3] !== questions) {
    bb0: {
      const submitText = hideSubmitTab ? "" : ` ${figures.tick} Submit `;
      const fixedWidth = stringWidth("\u2190 ") + stringWidth(" \u2192") + stringWidth(submitText);
      const availableForTabs = columns - fixedWidth;
      if (availableForTabs <= 0) {
        let t3;
        if ($[5] !== currentQuestionIndex || $[6] !== questions) {
          let t4;
          if ($[8] !== currentQuestionIndex) {
            t4 = (q, index) => {
              const header = q?.header || `Q${index + 1}`;
              return index === currentQuestionIndex ? header.slice(0, 3) : "";
            };
            $[8] = currentQuestionIndex;
            $[9] = t4;
          } else {
            t4 = $[9];
          }
          t3 = questions.map(t4);
          $[5] = currentQuestionIndex;
          $[6] = questions;
          $[7] = t3;
        } else {
          t3 = $[7];
        }
        t2 = t3;
        break bb0;
      }
      const tabHeaders = questions.map(_temp);
      const idealWidths = tabHeaders.map(_temp2);
      const totalIdealWidth = idealWidths.reduce(_temp3, 0);
      if (totalIdealWidth <= availableForTabs) {
        t2 = tabHeaders;
        break bb0;
      }
      const currentHeader = tabHeaders[currentQuestionIndex] || "";
      const currentIdealWidth = 4 + stringWidth(currentHeader);
      const currentTabWidth = Math.min(currentIdealWidth, availableForTabs / 2);
      const remainingWidth = availableForTabs - currentTabWidth;
      const otherTabCount = questions.length - 1;
      const widthPerOtherTab = Math.max(6, Math.floor(remainingWidth / Math.max(otherTabCount, 1)));
      let t3;
      if ($[10] !== currentQuestionIndex || $[11] !== currentTabWidth || $[12] !== widthPerOtherTab) {
        t3 = (header_1, index_1) => {
          if (index_1 === currentQuestionIndex) {
            const maxTextWidth = currentTabWidth - 2 - 2;
            return truncateToWidth(header_1, maxTextWidth);
          } else {
            const maxTextWidth_0 = widthPerOtherTab - 2 - 2;
            return truncateToWidth(header_1, maxTextWidth_0);
          }
        };
        $[10] = currentQuestionIndex;
        $[11] = currentTabWidth;
        $[12] = widthPerOtherTab;
        $[13] = t3;
      } else {
        t3 = $[13];
      }
      t2 = tabHeaders.map(t3);
    }
    $[0] = columns;
    $[1] = currentQuestionIndex;
    $[2] = hideSubmitTab;
    $[3] = questions;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  const tabDisplayTexts = t2;
  if (srEnabled) {
    let t8;
    let t9;
    if ($[41] !== answers || $[42] !== questions) {
      let t10;
      if ($[43] !== answers) {
        t10 = (q_2, index_3) => {
          const label = q_2?.header || `Q${index_3 + 1}`;
          const display = label.includes(",") || /answered/i.test(label) ? jsonStringify(label) : label;
          return getAnswerValue(answers, q_2?.question) ? `${display} (answered)` : display;
        };
        $[43] = answers;
        $[44] = t10;
      } else {
        t10 = $[44];
      }
      const labels = questions.map(t10);
      t8 = questions.length === 1 ? "Question" : "Questions";
      t9 = labels.join(", ");
      $[41] = answers;
      $[42] = questions;
      $[45] = t8;
      $[46] = t9;
    } else {
      t8 = $[45];
      t9 = $[46];
    }
    const listing = `${t8}: ${t9}`;
    let t11;
    if ($[47] !== listing) {
      t11 = <Text>{listing}</Text>;
      $[47] = listing;
      $[48] = t11;
    } else {
      t11 = $[48];
    }
    let t12;
    if ($[49] !== t11) {
      t12 = <Box marginBottom={1}>{t11}</Box>;
      $[49] = t11;
      $[50] = t12;
    } else {
      t12 = $[50];
    }
    return t12;
  }
  const hideArrows = questions.length === 1 && hideSubmitTab;
  let t3;
  if ($[14] !== currentQuestionIndex || $[15] !== hideArrows) {
    t3 = !hideArrows && <Text color={currentQuestionIndex === 0 ? "inactive" : undefined}>←{" "}</Text>;
    $[14] = currentQuestionIndex;
    $[15] = hideArrows;
    $[16] = t3;
  } else {
    t3 = $[16];
  }
  let t4;
  if ($[17] !== answers || $[18] !== currentQuestionIndex || $[20] !== questions || $[21] !== tabDisplayTexts) {
    let t5;
    if ($[23] !== answers || $[24] !== currentQuestionIndex || $[26] !== tabDisplayTexts) {
      t5 = (q_1, index_2) => {
        const isSelected = index_2 === currentQuestionIndex;
        const isAnswered = q_1?.question && !!answers[q_1.question];
        const checkbox = isAnswered ? figures.checkboxOn : figures.checkboxOff;
        const displayText = tabDisplayTexts[index_2] || q_1?.header || `Q${index_2 + 1}`;
        return <Box key={q_1?.question || `question-${index_2}`}>{isSelected ? <Text backgroundColor="permission" color="inverseText">{" "}{checkbox} {displayText}{" "}</Text> : <Text>{" "}{checkbox} {displayText}{" "}</Text>}</Box>;
      };
      $[23] = answers;
      $[24] = currentQuestionIndex;
      $[26] = tabDisplayTexts;
      $[27] = t5;
    } else {
      t5 = $[27];
    }
    t4 = questions.map(t5);
    $[17] = answers;
    $[18] = currentQuestionIndex;
    $[20] = questions;
    $[21] = tabDisplayTexts;
    $[22] = t4;
  } else {
    t4 = $[22];
  }
  let t5;
  if ($[28] !== currentQuestionIndex || $[29] !== hideSubmitTab || $[30] !== questions.length) {
    t5 = !hideSubmitTab && <Box key="submit">{currentQuestionIndex === questions.length ? <Text backgroundColor="permission" color="inverseText">{" "}{figures.tick} Submit{" "}</Text> : <Text> {figures.tick} Submit </Text>}</Box>;
    $[28] = currentQuestionIndex;
    $[29] = hideSubmitTab;
    $[30] = questions.length;
    $[31] = t5;
  } else {
    t5 = $[31];
  }
  let t6;
  if ($[32] !== currentQuestionIndex || $[33] !== hideArrows || $[34] !== questions.length) {
    t6 = !hideArrows && <Text color={currentQuestionIndex === questions.length ? "inactive" : undefined}>{" "}→</Text>;
    $[32] = currentQuestionIndex;
    $[33] = hideArrows;
    $[34] = questions.length;
    $[35] = t6;
  } else {
    t6 = $[35];
  }
  let t7;
  if ($[36] !== t3 || $[37] !== t4 || $[38] !== t5 || $[39] !== t6) {
    t7 = <Box flexDirection="row" marginBottom={1}>{t3}{t4}{t5}{t6}</Box>;
    $[36] = t3;
    $[37] = t4;
    $[38] = t5;
    $[39] = t6;
    $[40] = t7;
  } else {
    t7 = $[40];
  }
  return t7;
}
function _temp3(sum, w) {
  return sum + w;
}
function _temp2(header_0) {
  return 4 + stringWidth(header_0);
}
function _temp(q_0, index_0) {
  return q_0?.header || `Q${index_0 + 1}`;
}
/**
 * Mirror of the official SR-listing helper `hp(h,x)` (binary @275627560):
 *   `function hp(h,x){return x!==void 0&&Object.hasOwn(h,x)?h[x]:void 0}`
 * Returns the answer VALUE (or undefined). The listing mapper truthiness-tests
 * this, so an empty-string answer is falsy → NOT "(answered)". The hasOwn guard
 * avoids prototype-key false positives (e.g. a question keyed "toString").
 */
function getAnswerValue(answers: Record<string, string>, question: string | undefined): string | undefined {
  return question !== undefined && Object.hasOwn(answers, question) ? answers[question] : undefined;
}
