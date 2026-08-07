import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library registers this itself only when vitest runs with globals; this
// project does not, so without it every render stays in the document and
// `screen` queries see components from tests that already finished. A suite
// that renders the same component more than once then asserts against the
// first render's DOM — passing or failing for reasons that have nothing to do
// with the code under test.
afterEach(cleanup)
