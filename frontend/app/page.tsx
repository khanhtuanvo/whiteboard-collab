import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen bg-white font-sans">
      {/* Navbar */}
      <nav className="flex items-center justify-between px-8 py-4 border-b border-gray-100">
        <span className="text-xl font-bold text-gray-900">Collabboard</span>
        <div className="flex items-center gap-4">
          <Link href="/login" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
            Sign In
          </Link>
          <Link
            href="/register"
            className="text-sm bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Get Started Free
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex flex-col items-center text-center px-6 pt-24 pb-20">
        <div className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 text-xs font-medium px-3 py-1.5 rounded-full mb-6">
          <span className="w-1.5 h-1.5 bg-blue-500 rounded-full" />
          Real-time collaboration, now with AI
        </div>
        <h1 className="text-5xl md:text-6xl font-bold text-gray-900 max-w-3xl leading-tight mb-6">
          The whiteboard your team{' '}
          <span className="text-blue-600">actually uses</span>
        </h1>
        <p className="text-lg text-gray-500 max-w-xl mb-10">
          Draw, brainstorm, and build together in real time. AI-powered clustering keeps your ideas
          organized — no matter how big the board gets.
        </p>
        <div className="flex flex-col sm:flex-row gap-4">
          <Link
            href="/register"
            className="px-8 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors text-sm"
          >
            Start for free
          </Link>
          <Link
            href="/login"
            className="px-8 py-3 border border-gray-200 text-gray-700 font-semibold rounded-lg hover:bg-gray-50 transition-colors text-sm"
          >
            View demo
          </Link>
        </div>

        {/* Mock canvas preview */}
        <div className="mt-16 w-full max-w-4xl rounded-2xl border border-gray-200 shadow-2xl bg-gray-50 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 bg-white border-b border-gray-100">
            <div className="w-3 h-3 rounded-full bg-red-400" />
            <div className="w-3 h-3 rounded-full bg-yellow-400" />
            <div className="w-3 h-3 rounded-full bg-green-400" />
            <span className="ml-3 text-xs text-gray-400">collabboard.app / boards / Q1-planning</span>
          </div>
          <div className="h-72 flex items-center justify-center text-gray-300 text-4xl select-none">
            🖊
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="px-6 py-20 bg-gray-50">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-gray-900 text-center mb-4">Everything your team needs</h2>
          <p className="text-center text-gray-500 mb-14 max-w-lg mx-auto">
            From quick sketches to full sprint planning — Collabboard handles it all.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <FeatureCard
              icon="⚡"
              title="Real-time Collaboration"
              description="See every cursor, every stroke, and every change as it happens. Work together across the world with zero lag."
            />
            <FeatureCard
              icon="🤖"
              title="AI Organization"
              description="Let AI automatically cluster and group your sticky notes and ideas, surfacing structure from the chaos."
            />
            <FeatureCard
              icon="📤"
              title="Export Anywhere"
              description="Download your board as a high-resolution PNG or SVG in one click. Share with stakeholders instantly."
            />
          </div>
        </div>
      </section>

      {/* Tech stack badges */}
      <section className="px-6 py-16 border-t border-gray-100">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-sm text-gray-400 uppercase tracking-widest mb-8 font-medium">Built with</p>
          <div className="flex flex-wrap justify-center gap-3">
            {[
              'Next.js 15',
              'TypeScript',
              'Fabric.js',
              'Socket.IO',
              'Prisma',
              'MySQL',
              'Redis',
              'Tailwind CSS',
              'Claude AI',
            ].map((tech) => (
              <span
                key={tech}
                className="px-4 py-2 rounded-full border border-gray-200 text-sm text-gray-600 bg-white font-medium"
              >
                {tech}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* CTA footer strip */}
      <section className="px-6 py-20 bg-blue-600">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-3xl font-bold text-white mb-4">Ready to collaborate?</h2>
          <p className="text-blue-100 mb-8">Create your first board in seconds — no credit card required.</p>
          <Link
            href="/register"
            className="inline-block px-8 py-3 bg-white text-blue-600 font-semibold rounded-lg hover:bg-blue-50 transition-colors text-sm"
          >
            Get started free
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-8 py-6 border-t border-gray-100 flex items-center justify-between text-sm text-gray-400">
        <span>© 2026 Collabboard</span>
        <div className="flex gap-6">
          <Link href="/login" className="hover:text-gray-600 transition-colors">Sign In</Link>
          <Link href="/register" className="hover:text-gray-600 transition-colors">Register</Link>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <div className="bg-white rounded-xl p-6 border border-gray-100 shadow-sm">
      <div className="text-3xl mb-4">{icon}</div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
      <p className="text-gray-500 text-sm leading-relaxed">{description}</p>
    </div>
  );
}
