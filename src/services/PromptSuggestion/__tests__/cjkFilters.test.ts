import { describe, expect, test } from 'bun:test'
import {
  shouldFilterSuggestion,
  stripSuggestionMeta,
} from '../promptSuggestion'

/**
 * Official Claude Code 2.1.269 (E27 + E51):
 * - E27: CJK/Thai-aware word counting (KQn/VQn/YQn cluster) feeding the
 *   'too_few_words'/'too_many_words' filters, plus CJK extensions to the
 *   'done', 'meta_text', 'meta_wrapped', 'multiple_sentences', 'evaluative'
 *   and 'claude_voice' filters.
 * - E51: meta-label strip chain gains CJK/Korean labels (提案/回答/返信/応答/
 *   出力/結果/建议/回复/答案/输出/结果/제안/답변/응답/출력/결과) and the
 *   fullwidth colon (：).
 */

function filtered(suggestion: string): boolean {
  return shouldFilterSuggestion(suggestion, 'user_intent')
}

describe('2.1.269 E27: CJK-aware word counting in too_few_words', () => {
  test("Chinese '帮我修复这个bug' counts >= 2 words and is kept", () => {
    // han=6 (帮我修复这个) → 6/2=3, plus mixed-script remainder (+1) → 4 words
    expect(filtered('帮我修复这个bug')).toBe(false)
  })

  test('single han character is dropped (too_few_words)', () => {
    expect(filtered('好')).toBe(true)
  })

  test('two han characters are kept via the CJK count branch', () => {
    // KQn('好的') = ceil(2/2) = 1 < 2, but VQn = 2 → cjkCount >= 2 → kept
    expect(filtered('好的')).toBe(false)
  })

  test('mixed-script single word is kept', () => {
    // han=2 → 2/2=1, +1 for the latin remainder → 2 words
    expect(filtered('修复bug')).toBe(false)
  })

  test('Thai text counts phonetic characters (4 chars ≈ 1 word)', () => {
    // 9 Thai chars → 9/4 = 2.25 → ceil = 3 words → kept
    expect(filtered('สวัสดีครับ')).toBe(false)
  })

  test('single kana character is dropped', () => {
    expect(filtered('あ')).toBe(true)
  })

  test('slash commands bypass too_few_words unchanged', () => {
    expect(filtered('/help')).toBe(false)
  })

  test('too_many_words uses the CJK-aware count', () => {
    // 30 han chars → 30/2 = 15 words > 12 → filtered
    expect(filtered('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十')).toBe(
      true,
    )
    // 24 han chars → 12 words, not > 12 → kept
    expect(filtered('一二三四五六七八九十一二三四五六七八九十')).toBe(false)
  })
})

describe('2.1.269 E27: CJK done filter', () => {
  test("Japanese '完了' is filtered as done", () => {
    expect(filtered('完了')).toBe(true)
  })

  test("Japanese '完了しました' is filtered as done", () => {
    expect(filtered('完了しました')).toBe(true)
  })

  test("Chinese '完成' is filtered as done", () => {
    expect(filtered('完成')).toBe(true)
  })

  test("Chinese '完成了' is filtered as done", () => {
    expect(filtered('完成了')).toBe(true)
  })

  test("Korean '완료' and '완료됨' are filtered as done", () => {
    expect(filtered('완료')).toBe(true)
    expect(filtered('완료됨')).toBe(true)
  })

  test('done wrapped in non-letter punctuation is still filtered', () => {
    expect(filtered('「完了」')).toBe(true)
    expect(filtered('done!')).toBe(true)
  })

  test("English 'done' still filtered (regression)", () => {
    expect(filtered('done')).toBe(true)
  })

  test('done embedded in a longer sentence is NOT filtered', () => {
    expect(filtered('mark the task as 完了 in the tracker')).toBe(false)
  })
})

describe('2.1.269 E27: CJK meta_text / meta_wrapped / evaluative / claude_voice', () => {
  test("Chinese '沉默' is filtered as meta_text", () => {
    expect(filtered('沉默')).toBe(true)
  })

  test("Japanese '提案なし' is filtered as meta_text", () => {
    expect(filtered('提案なし')).toBe(true)
  })

  test("Korean '제안 없음' is filtered as meta_text", () => {
    expect(filtered('제안 없음')).toBe(true)
  })

  test('fullwidth-wrapped meta is filtered as meta_wrapped', () => {
    expect(filtered('（沈黙）')).toBe(true)
    expect(filtered('【no suggestion】')).toBe(true)
  })

  test('ascii-wrapped meta still filtered (regression)', () => {
    expect(filtered('(silence — nothing obvious)')).toBe(true)
    expect(filtered('[no suggestion]')).toBe(true)
  })

  test("Chinese '谢谢' is filtered as evaluative", () => {
    expect(filtered('谢谢')).toBe(true)
  })

  test("Japanese 'ありがとうございます' is filtered as evaluative", () => {
    expect(filtered('ありがとうございます')).toBe(true)
  })

  test("Korean '감사합니다' is filtered as evaluative", () => {
    expect(filtered('감사합니다')).toBe(true)
  })

  test("Chinese '太好了' is filtered as evaluative", () => {
    expect(filtered('太好了')).toBe(true)
  })

  test("Chinese Claude-voice '让我看看' is filtered", () => {
    expect(filtered('让我看看')).toBe(true)
  })

  test("Chinese '让我们看看' is NOT claude_voice (negative lookahead 们)", () => {
    expect(filtered('让我们看看')).toBe(false)
  })

  test("CJK sentence terminator triggers multiple_sentences", () => {
    expect(filtered('运行测试。然后提交')).toBe(true)
  })
})

describe('2.1.269 E27: English regression (behavior unchanged)', () => {
  test('whitelisted single words are kept', () => {
    for (const w of [
      'yes',
      'yeah',
      'yep',
      'yea',
      'yup',
      'sure',
      'ok',
      'okay',
      'push',
      'commit',
      'deploy',
      'stop',
      'continue',
      'check',
      'exit',
      'quit',
      'no',
    ]) {
      expect(filtered(w)).toBe(false)
    }
  })

  test('non-whitelisted single English word is dropped', () => {
    expect(filtered('maybe')).toBe(true)
  })

  test('normal multi-word suggestion is kept', () => {
    expect(filtered('run the tests')).toBe(false)
  })

  test('evaluative English is filtered', () => {
    expect(filtered('thanks')).toBe(true)
    expect(filtered('looks good')).toBe(true)
  })

  test('claude-voice English is filtered', () => {
    expect(filtered("let me check that")).toBe(true)
    expect(filtered("Here's the fix")).toBe(true)
  })

  test('error messages are filtered', () => {
    expect(filtered('API error: rate limited')).toBe(true)
  })

  test('prefixed label is filtered', () => {
    expect(filtered('Suggestion: run tests')).toBe(true)
  })

  test('empty suggestion is filtered', () => {
    expect(shouldFilterSuggestion(null, 'user_intent')).toBe(true)
    expect(shouldFilterSuggestion('', 'user_intent')).toBe(true)
  })

  test('too long suggestion is filtered', () => {
    expect(filtered('a'.repeat(100))).toBe(true)
  })
})

describe('2.1.269 E51: meta-label strip chain', () => {
  test('strips tag wrapper', () => {
    expect(stripSuggestionMeta('<suggestion>run tests</suggestion>')).toBe(
      'run tests',
    )
    expect(stripSuggestionMeta('<ANSWER>yes</ANSWER>')).toBe('yes')
  })

  test('keeps wrapper when inner text contains a closing tag', () => {
    const input = '<suggestion>use </suggestion> to end</suggestion>'
    expect(stripSuggestionMeta(input)).toBe(input)
  })

  test('strips English labels with ascii colon', () => {
    expect(stripSuggestionMeta('Suggestion: run tests')).toBe('run tests')
    expect(stripSuggestionMeta('Suggested reply: ok')).toBe('ok')
    expect(stripSuggestionMeta('Answer: yes')).toBe('yes')
  })

  test('strips CJK labels with fullwidth colon (2.1.269 delta)', () => {
    expect(stripSuggestionMeta('提案：run the tests')).toBe('run the tests')
    expect(stripSuggestionMeta('回答：好的')).toBe('好的')
    expect(stripSuggestionMeta('応答: yes')).toBe('yes')
    expect(stripSuggestionMeta('结果：done')).toBe('done')
  })

  test('strips simplified-Chinese and Korean labels', () => {
    expect(stripSuggestionMeta('建议：运行测试')).toBe('运行测试')
    expect(stripSuggestionMeta('답변: 네')).toBe('네')
    expect(stripSuggestionMeta('출력：ok')).toBe('ok')
  })

  test('does not strip label words without a colon', () => {
    expect(stripSuggestionMeta('suggestion box')).toBe('suggestion box')
  })

  test('plain text passes through trimmed', () => {
    expect(stripSuggestionMeta('  run the tests  ')).toBe('run the tests')
  })
})
