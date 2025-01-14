import type { Element, ElementContent } from 'hast'
import type { DecorationItem, OffsetOrPosition, ResolvedDecorationItem, ResolvedPosition, ShikiTransformer, ShikiTransformerContextMeta, ShikiTransformerContextSource } from './types'
import { addClassToHast, createPositionConverter, splitTokens } from './utils'

interface TransformerDecorationsInternalContext {
  decorations: ResolvedDecorationItem[]
  converter: ReturnType<typeof createPositionConverter>
  source: string
}

/**
 * A built-in transformer to add decorations to the highlighted code.
 */
export function transformerDecorations(): ShikiTransformer {
  const map = new WeakMap<ShikiTransformerContextMeta, TransformerDecorationsInternalContext>()

  function getContext(shiki: ShikiTransformerContextSource) {
    if (!map.has(shiki.meta)) {
      const converter = createPositionConverter(shiki.source)

      function normalizePosition(p: OffsetOrPosition): ResolvedPosition {
        if (typeof p === 'number') {
          return {
            ...converter.indexToPos(p),
            offset: p,
          }
        }
        else {
          return {
            ...p,
            offset: converter.posToIndex(p.line, p.character),
          }
        }
      }

      const decorations = (shiki.options.decorations || [])
        .map((d): ResolvedDecorationItem => ({
          ...d,
          start: normalizePosition(d.start),
          end: normalizePosition(d.end),
        }))

      verifyIntersections(decorations)

      map.set(shiki.meta, {
        decorations,
        converter,
        source: shiki.source,
      })
    }

    return map.get(shiki.meta)!
  }

  function verifyIntersections(items: ResolvedDecorationItem[]) {
    for (let i = 0; i < items.length; i++) {
      const foo = items[i]
      if (foo.start.offset > foo.end.offset)
        throw new Error(`[Shiki] Invalid decoration range: ${JSON.stringify(foo.start)} - ${JSON.stringify(foo.end)}`)

      for (let j = i + 1; j < items.length; j++) {
        const bar = items[j]
        const isFooHasBarStart = foo.start.offset < bar.start.offset && bar.start.offset < foo.end.offset
        const isFooHasBarEnd = foo.start.offset < bar.end.offset && bar.end.offset < foo.end.offset
        const isBarHasFooStart = bar.start.offset < foo.start.offset && foo.start.offset < bar.end.offset
        const isBarHasFooEnd = bar.start.offset < foo.end.offset && foo.end.offset < bar.end.offset
        if (isFooHasBarStart || isFooHasBarEnd || isBarHasFooStart || isBarHasFooEnd) {
          if (isFooHasBarEnd && isFooHasBarEnd)
            continue // nested
          if (isBarHasFooStart && isBarHasFooEnd)
            continue // nested
          throw new Error(`[Shiki] Decorations ${JSON.stringify(foo.start)} and ${JSON.stringify(bar.start)} intersect.`)
        }
      }
    }
  }

  return {
    name: 'shiki:decorations',
    tokens(tokens) {
      if (!this.options.decorations?.length)
        return
      const ctx = getContext(this)
      const breakpoints = ctx.decorations.flatMap(d => [d.start.offset, d.end.offset])
      const splitted = splitTokens(tokens, breakpoints)
      return splitted
    },
    code(codeEl) {
      if (!this.options.decorations?.length)
        return
      const ctx = getContext(this)

      const lines = Array.from(codeEl.children).filter(i => i.type === 'element' && i.tagName === 'span') as Element[]

      // if (lines.length !== ctx.converter.lines.length)
      //   throw new Error(`[Shiki] Number of lines in code element (${lines.length}) does not match the number of lines in the source (${ctx.converter.lines.length}). Failed to apply decorations.`)

      function applyLineSection(line: number, start: number, end: number, decoration: DecorationItem) {
        const lineEl = lines[line]
        let text = ''
        let startIndex = -1
        let endIndex = -1

        function stringify(el: ElementContent): string {
          if (el.type === 'text')
            return el.value
          if (el.type === 'element')
            return el.children.map(stringify).join('')
          return ''
        }

        if (start === 0)
          startIndex = 0
        if (end === 0)
          endIndex = 0
        if (end === Number.POSITIVE_INFINITY)
          endIndex = lineEl.children.length

        if (startIndex === -1 || endIndex === -1) {
          for (let i = 0; i < lineEl.children.length; i++) {
            text += stringify(lineEl.children[i])
            if (startIndex === -1 && text.length === start)
              startIndex = i + 1
            if (endIndex === -1 && text.length === end)
              endIndex = i + 1
          }
        }

        if (startIndex === -1)
          throw new Error(`[Shiki] Failed to find start index for decoration ${JSON.stringify(decoration.start)}`)
        if (endIndex === -1)
          throw new Error(`[Shiki] Failed to find end index for decoration ${JSON.stringify(decoration.end)}`)

        const children = lineEl.children.slice(startIndex, endIndex)
        const element: Element = !decoration.alwaysWrap && children.length === 1 && children[0].type === 'element'
          ? children[0]
          : {
              type: 'element',
              tagName: 'span',
              properties: {},
              children,
            }

        applyDecoration(element, decoration, false)

        lineEl.children.splice(startIndex, children.length, element)
      }

      function applyLine(line: number, decoration: DecorationItem) {
        lines[line] = applyDecoration(lines[line], decoration, true)
      }

      function applyDecoration(el: Element, decoration: DecorationItem, isLine: boolean) {
        const properties = decoration.properties || {}
        const transform = decoration.transform || (i => i)

        el.tagName = decoration.tagName || 'span'
        el.properties = {
          ...el.properties,
          ...properties,
          class: el.properties.class,
        }
        if (decoration.properties?.class)
          addClassToHast(el, decoration.properties.class as string[])
        el = transform(el, isLine) || el
        return el
      }

      const lineApplies: (() => void)[] = []

      // Apply decorations in reverse order so the nested ones get applied first.
      const sorted = ctx.decorations.sort((a, b) => b.start.offset - a.start.offset)
      for (const decoration of sorted) {
        const { start, end } = decoration
        if (start.line === end.line) {
          applyLineSection(start.line, start.character, end.character, decoration)
        }
        else if (start.line < end.line) {
          applyLineSection(start.line, start.character, Number.POSITIVE_INFINITY, decoration)
          for (let i = start.line + 1; i < end.line; i++)
            lineApplies.unshift(() => applyLine(i, decoration))
          applyLineSection(end.line, 0, end.character, decoration)
        }
      }

      lineApplies.forEach(i => i())
    },
  }
}
