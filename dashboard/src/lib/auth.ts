// cortextOS Dashboard - NextAuth v5 configuration
// Credentials provider backed by SQLite users table

import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from './db';
import type { User } from './types';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null;

        // Seed admin user on first auth attempt if no users exist
        await seedAdminUser();

        const user = db
          .prepare('SELECT * FROM users WHERE username = ?')
          .get(credentials.username as string) as User | undefined;
        if (!user) return null;

        const valid = await bcrypt.compare(
          credentials.password as string,
          user.password_hash
        );
        if (!valid) return null;

        return {
          id: String(user.id),
          name: user.username,
        };
      },
    }),
  ],
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (token.id && session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
    authorized({ auth: session }) {
      return !!session;
    },
  },
});

/** Seed admin user from env vars if no users exist in the database */
export async function seedAdminUser(): Promise<void> {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM users')
    .get() as { count: number };

  if (row.count > 0) return;

  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const password = process.env.ADMIN_PASSWORD ?? 'cortextos';

  const hash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
    username,
    hash
  );

  console.log(`[auth] Seeded admin user: ${username}`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn(
      '[auth] Using default password "cortextos". Set ADMIN_PASSWORD env var for production.'
    );
  }
}
