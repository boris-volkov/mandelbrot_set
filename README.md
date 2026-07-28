# mandelbrot_set

**[▶ Run it](https://boris-volkov.github.io/mandelbrot_set/)**

![mandelbrot_set](Screenshot%20from%202021-02-08%2021-36-26.png)

It's a strange miracle that this thing exists at all, and perhaps still stranger that anyone found it, but here it is, for us to enjoy. Click anywhere on the picture to zoom in, and you will see that you can somehow ... <i>just keep zooming</i>. Really, try it!

I say it is a miracle because its discovery is rooted in the unlikely answer of "what is the square root of negative one?" Even after a suitable answer to that question was formalized in mathematics, it still took hundreds of years of human development to get to the point that we can display this image and explore it. It could technically be drawn with a box of crayons and A LOT of time, but it really took the development of an electronic computer in order to render it in any reasonable amount of time.

This object is called the Mandelbrot set, named after the famous fractal mathematician Benoit B. Mandelbrot (if you asked him what the B. stands for, he would answer: "Benoit B. Mandelbrot", and if you aksed him what THAT B stood for... well... what do you think?) This picture behaves in just the same way, no matter how far you zoom into it, you keep seeing more copies of the same thing. Well, not the same thing, but rather, variations on several themes: depending on where you look, you will find spirals, structures that look like trees, flowers, rivers, galaxies, bad hair days... all sorts of natural-looking formations of seemingly infinite variety. 

You would think that a graph of such complexity would be the result of an equally complicated looking equation, but in fact it is produced by the rather tame quadratic equation of a complex variable: 

	f(z) = z² + c

Only nine symbols...

How does it work? Every point c on the complex plane is colored based on how quickly the sequence produced by the recursive iteration of this function diverges when starting at z = 0. I refer you to the excellent wikipedia article about it if you would like a more detailed description. The mathematics required is accessible to the modern high-schooler, and even younger, if you are ambitious! (Algebra2 standard, topics: complex numbers, function composition). 

As a math teacher, a question you are frequently asked is "but when will I ever use this in real life?" The most honest answer I can give them is "maybe never"... but... "not everything you learn in school is meant to be useful. Some of it is just interesting and beautiful and makes you enjoy your life a little more. And that's okay." Some of the most important things in life have no particular use. What is the use of music, for example, or of a soccer game? These are just things we enjoy, without bothering much about their use. Wouldn't a person be missing the point if they said that the use of a soccer game is "to exercise" or "to fulfill some evolutionary goal"? It would take all the magic out. And this graph seems to me like magic. This graph is one of my favorite examples of something in math that need not be useful in order to be interesting. People all over the world have marveled at the detail of it, the dazzling colors and shapes. 

The code for this current interface is largely based on that provided in the O'Reilly book, but is pretty heavily modified in order to unwrap the mandelbrot object class into a set of global parameters, so as to be more easily spoken to by the html buttons, which are here implemented as simple <div>'s with click-listeners. The same book is where I got the technique of dividing the work among web-workers in order to invoke multiple threads simultaneously and speed up the work.

## Getting around

| | |
|---|---|
| click, scroll | zoom in on a point |
| drag | pan |
| arrows | pan by a tenth of a screen |
| `i` / `o` | zoom in / out |
| `+` / `−` | more / fewer iterations |
| `a` | automatic iteration count |
| `p` | next palette |
| `c` | shift the colours along |
| `[` / `]` | wider / narrower colour bands |
| `l` | copy a link to exactly this view |
| `s` | save a PNG |
| `h` | hide the interface |
| `esc` | back to the start |

Every view lives in the URL, so a link is a place. The address bar updates as you go.

## How deep it goes

The obvious way to draw this picture runs out of room surprisingly early. A
JavaScript number carries about 16 significant digits, so once a single pixel
spans less than about 1e-15 of the plane, neighbouring pixels stop being
distinguishable and the image dissolves into blocks. That's a magnification of
around a million million — far, and yet nowhere at all, given that the detail
genuinely never stops.

JavaScript does have arbitrary precision, in the form of `BigInt`: integers of
unlimited size, built into the language. There are no arbitrary-precision
*decimals*, but you can build them, and `src/fixed.js` does — a number is
stored as a big integer scaled by a power of two, so 300 digits of precision is
just a bigger integer.

The catch is that `BigInt` arithmetic is a hundred-odd times slower than
ordinary arithmetic. Doing every pixel that way would take hours per frame.
So instead, `src/kernel.js` uses **perturbation**: one single point at the
centre of the screen gets the full high-precision treatment, and every other
pixel is computed as a tiny *difference* from it. If you write z = Z + d and
grind through the algebra, the difference obeys

	d → 2·Z·d + d² + dc

which involves only small numbers, and runs at ordinary speed. One expensive
orbit buys a whole frame of cheap ones. When d grows large enough to swamp its
own precision, the loop *rebases* — restarts against the beginning of the
reference orbit, which is an exact identity rather than an approximation, and
is what keeps the picture free of the artefacts this technique is otherwise
known for.

The upshot: the readout tells you when it has switched from `double precision`
to `perturbation`, and how many bits it's carrying. Renders that take a while
get a timer and a progress bar, and can be stopped.

## How many iterations

Every pixel gets a limit on how long it may run before we give up and call it
part of the set. Set it too low and the picture lies to you: detail turns into
a black blob. Set it too high and you wait for nothing.

The obvious thing is to raise the limit with depth. It doesn't work, and it
isn't close. What a frame needs depends overwhelmingly on *where* it is. At one
fixed scale, 2.1e-14 per pixel:

| where | iterations needed |
|---|---|
| a spot on the antenna | 27,750 |
| a spot in seahorse valley | 4,655 |
| a spot by a mini-Mandelbrot | 400 |

Seventy-fold spread at identical depth — and the ordering reshuffles as you go
deeper: at 1e-9 per pixel the seahorse spot was the hungry one, at 22,200.

So the limit is measured, not predicted. Before rendering a frame properly, the
renderer draws it a few times at postage-stamp size and watches the black area.
Raising the limit can only ever turn black pixels into coloured ones, so *how
much black goes away when I raise it* is exactly *how much of this frame is a
lie*. It climbs while that's worth having, comes back down for as long as it
costs nothing, and stops — usually four to eight probes, each a few thousand
pixels, against a frame of millions.

`a` turns it off; `+` and `−` then set the limit by hand.

## Getting there smoothly

Frames are built off-screen and only shown when they're ready, which is what
keeps the picture from twitching while it loads. Two things fall out of that.

When you click to zoom, the outgoing frame is stretched toward the incoming one
over a few hundred milliseconds, and the animation is *paced against the
render* — if the new frame is going to be slow, the move stretches to meet it,
so you arrive about when the pixels do. Before any of that starts, the buffer
is seeded with the outgoing frame warped into the incoming frame's geometry.
That seed is exactly what the animation shows at the moment it lands, so the
handover is invisible; tiles then sharpen it in place rather than appearing out
of nothing.

The move runs at one speed throughout, and takes as long as it takes — a frame
that needs half a minute gets a move that lasts half a minute, so you're still
travelling when the pixels arrive rather than parked in front of a blur.

Scale interpolates *geometrically* — zoom is multiplicative, so even travel
through the exponent is even travel to the eye, where interpolating the scale
itself would look like falling. Progress is carried from frame to frame rather
than recomputed from the clock, because the duration gets revised mid-move once
the render admits how slow it is, and `elapsed / duration` would then fall: the
zoom used to visibly run backwards by a fifth of the move before jumping
forward again. For the same reason the pace is set against elapsed time and not
against the fraction of the move left — that reads as equivalent but feeds
back, stretching the duration as the end nears until the move decays towards
the finish without ever arriving.

The colours hold still too, which took three goes to get right.

`pow(nu, 0.4)` spreads escape counts over the palette nicely when they run from
1 to a few hundred. Deep down they all land between (say) 37,900 and 38,100,
the curve is nearly flat across a window that narrow, and the frame comes out
one colour. So something has to stretch it back open.

The obvious something is the spread of escape values measured in the frame:
stretch until that fills the palette once. It works, and it is wrong, because
it makes the palette follow the picture. Zoom into a smooth region and the
spread halves on every step — so the scale doubles on every step, and the
colours change on every single click. Going ×1, ×8, ×32, ×64, ×256 in five
zooms is not a colour scheme, it's a strobe.

What the stretch is really compensating for is the curve flattening, and that
depends on how big escape counts are around here, not on what today's frame
happens to contain. `pow(nu, 0.4)` has slope `0.4·nu^-0.6`, so scaling by
`nu^0.6` cancels it exactly — with the iteration limit standing in for `nu`.
That moves slowly and predictably, so the colours hold. Rounded to a power of
two on top, the scale changes **twice** over a 40-step descent instead of forty
times, and level 0 is the mapping this program has always used.

Nothing is anchored to where the range starts, either. Pinning the lowest
escape value to the start of the palette looks right, but the palette is a
*cycle* — an anchor buys no extra colour, it only rotates the wheel — and since
the range shifts a little every step, anchoring to it turned every step into a
rotation.

On top of all that sit the two controls, which are simply the two things you
can do to a cycle: `[` and `]` change its **frequency**, how many times the
palette repeats across the picture, from a broad wash to banding at the pixel
level; `c` changes its **phase**, sliding the whole thing along. Both are pure
re-colouring — under a millisecond, no iteration recomputed — and both ride in
the URL, so a link carries the colours you chose.

Within a frame, the palette was also being re-derived as tiles arrived, so the
image re-coloured under you mid-render. It doesn't depend on the tiles at all
now, so there is nothing left to re-derive.

`test.html` checks the arithmetic against a deliberately slow, obviously
correct version that does every single iteration in full precision. At 1e-24
and 1e-60 per pixel the fast path agrees with it exactly.
