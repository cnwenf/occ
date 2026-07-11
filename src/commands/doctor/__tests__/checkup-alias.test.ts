import { describe, expect, test } from 'bun:test'
import doctor from '../index.js'

/**
 * claude-code 2.1.205 #21: /checkup is an alias for /doctor. Mirrors the
 * official binary's `{name:"doctor", aliases:["checkup"]}` registration.
 */
describe('2.1.205 #21 /checkup alias for /doctor', () => {
  test("doctor command has 'checkup' in its aliases", () => {
    expect(doctor.aliases).toContain('checkup')
    expect(doctor.name).toBe('doctor')
  })
})
