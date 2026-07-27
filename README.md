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
| `c`, `[`, `]` | shift the colours, spread them out or in |
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

The colours hold still too. The palette is stretched to the range of escape
values in the frame, and that range used to be discovered as tiles arrived —
which meant the whole image re-coloured under you, repeatedly, mid-render. Now
a probe pass renders a postage-stamp version of the frame first, purely to
learn the range, and the palette is pinned before a single real pixel is
coloured. It costs well under 1% of a frame.

`test.html` checks the arithmetic against a deliberately slow, obviously
correct version that does every single iteration in full precision. At 1e-24
and 1e-60 per pixel the fast path agrees with it exactly.
