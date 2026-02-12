import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { knowledgeEntries, searchConfigs } from './schema'
import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const dbPath = process.env.DATABASE_PATH || './data/job-hunter.db'

const dir = dirname(dbPath)
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true })
}

const sqlite = new Database(dbPath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

const db = drizzle(sqlite)

// Run migrations first
migrate(db, { migrationsFolder: './server/db/migrations' })

console.log('Database migrated. Seeding knowledge base...\n')

const entries = [
  // Profile
  { category: 'profile', key: 'Full Name', value: 'Devin Hollister-Graham', source: 'resume' },
  { category: 'profile', key: 'Email', value: 'hollistergraham123@gmail.com', source: 'resume' },
  { category: 'profile', key: 'Phone', value: '(417) 619-8982', source: 'resume' },
  { category: 'profile', key: 'GitHub', value: 'Devin345458', source: 'resume' },
  { category: 'profile', key: 'Professional Summary', value: 'Software developer with over 6 years of experience in web and mobile application development. Proven track record of leading development teams, architecting scalable solutions, and delivering high-performance applications. Seeking a senior software developer or leadership role where I can continue driving technical innovation and improving development processes.', source: 'resume' },
  { category: 'profile', key: 'Years of Experience', value: '6+', source: 'resume' },
  { category: 'profile', key: 'Target Role', value: 'Senior Software Developer or Technical Lead', source: 'resume' },

  // Skills - Languages
  { category: 'skill', key: 'PHP', value: 'Primary backend language with 6+ years experience. Used extensively with Laravel and CakePHP frameworks.', source: 'resume' },
  { category: 'skill', key: 'JavaScript', value: 'Full-stack JavaScript development including Node.js, Vue.js, and Express. 6+ years experience.', source: 'resume' },
  { category: 'skill', key: 'TypeScript', value: 'TypeScript for type-safe frontend and backend development.', source: 'resume' },
  { category: 'skill', key: 'Node.js', value: 'Server-side JavaScript runtime. Used for microservice architectures and API development.', source: 'resume' },
  { category: 'skill', key: 'MySQL', value: 'Primary relational database. Experience with large-scale data, query optimization, and schema design.', source: 'resume' },
  { category: 'skill', key: 'CSS/SASS/LESS', value: 'Frontend styling with preprocessors. SCSS with BEM naming convention.', source: 'resume' },

  // Skills - Frameworks
  { category: 'skill', key: 'Laravel', value: 'Primary PHP framework. Built APIs, full-stack apps, and SaaS products. Deep knowledge of Eloquent, queues, events, and the ecosystem.', source: 'resume' },
  { category: 'skill', key: 'CakePHP', value: 'Used for legacy application modernization. Led complete redesign of monolithic PHP app to CakePHP API.', source: 'resume' },
  { category: 'skill', key: 'Vue.js', value: 'Primary frontend framework. Vue 3 with Composition API, Vuetify 3, state management. Used across all major projects.', source: 'resume' },
  { category: 'skill', key: 'AdonisJS', value: 'Node.js MVC framework experience.', source: 'resume' },
  { category: 'skill', key: 'Express', value: 'Node.js web framework for REST APIs and microservices.', source: 'resume' },
  { category: 'skill', key: 'CapacitorJS', value: 'Mobile app development wrapping web apps for iOS and Android. Used with Vue.js for cross-platform apps.', source: 'resume' },
  { category: 'skill', key: 'Socket.IO', value: 'Real-time bidirectional communication. Implemented real-time transit information systems.', source: 'resume' },
  { category: 'skill', key: 'Jest', value: 'JavaScript testing framework.', source: 'resume' },
  { category: 'skill', key: 'PHPUnit', value: 'PHP testing framework.', source: 'resume' },

  // Skills - Tools & Technologies
  { category: 'skill', key: 'GitHub Actions', value: 'CI/CD pipeline creation. Standardized team workflows with automated linting, testing, and deployment.', source: 'resume' },
  { category: 'skill', key: 'Elasticsearch', value: 'Search engine for full-text search and analytics. Used with billion-record datasets.', source: 'resume' },
  { category: 'skill', key: 'Redis', value: 'In-memory data store for caching, queues, and real-time data.', source: 'resume' },
  { category: 'skill', key: 'Webpack', value: 'JavaScript module bundler for frontend build systems.', source: 'resume' },
  { category: 'skill', key: 'AWS', value: 'Cloud infrastructure management. Experience with AWS services for hosting and deployment.', source: 'resume' },
  { category: 'skill', key: 'DigitalOcean', value: 'Cloud hosting platform. Managed infrastructure for multiple projects.', source: 'resume' },
  { category: 'skill', key: 'Kubernetes', value: 'Container orchestration. Migrated internal development servers to Kubernetes, reducing costs.', source: 'resume' },
  { category: 'skill', key: 'Kafka', value: 'Distributed event streaming. Used for processing billion-record datasets.', source: 'resume' },
  { category: 'skill', key: 'Sentry', value: 'Error tracking and performance monitoring. Deployed and maintained self-hosted instance across 50 projects, reducing debugging time by 30%.', source: 'resume' },
  { category: 'skill', key: 'SCRUM/Agile', value: 'Agile methodology practitioner. Led SCRUM meetings and managed sprints across multiple teams.', source: 'resume' },
  { category: 'skill', key: 'MongoDB', value: 'NoSQL document database. Used with large-scale data processing pipelines.', source: 'resume' },
  { category: 'skill', key: 'Clickhouse', value: 'Column-oriented database for analytics workloads.', source: 'resume' },

  // Experience
  { category: 'experience', key: 'Applied Imagination - Senior Developer', value: 'Oct 2021 - Present | Remote\n\nAccomplishments:\n- Scoped and secured multiple contracts valued at over $5M annually, contributing to significant revenue growth.\n- Standardized team coding practices through linters and GitHub Actions, resulting in cohesive codebase and streamlined workflows.\n- Migrated internal development servers to Kubernetes, reducing costs and accelerating project deployments.\n- Established a private Composer and NPM repository, reducing QA issues and cutting development costs.\n- Implemented password policies and credential sharing via a private Vault, ensuring HIPAA compliance.\n- Deployed and maintained a self-hosted Sentry instance across 50 projects, reducing debugging time by 30%.\n\nResponsibilities:\n- Scoped and quoted projects, defining technical stack, phases, and pricing with sales teams.\n- Defined development infrastructure, selected technology stacks, and created project templates.\n- Provided code reviews, peer programming, and technical coaching for a team of 7 developers.\n- Coached and led the team of developers and QA staff.', source: 'resume' },

  { category: 'experience', key: 'Market Maker Leads - Senior Developer', value: 'Jul 2020 - Oct 2021 | Springfield, MO\n\nAccomplishments:\n- Led the complete redesign of a monolithic PHP application into a scalable CakePHP API backend with a Vue.js frontend.\n- Designed and implemented new features to meet evolving real estate needs during and after COVID-19.\n\nResponsibilities:\n- Worked with stakeholders to plan quarterly objectives addressing multi-departmental needs.\n- Conducted peer code reviews to ensure best practices and code quality.\n- Participated in weekly SCRUM meetings.', source: 'resume' },

  { category: 'experience', key: 'Frontier Business Group - CTO', value: 'May 2019 - Jul 2020 | Springfield, MO\n\nAccomplishments:\n- Spearheaded expansion from marketing websites into web applications, significantly increasing revenue potential.\n- Hired, trained, and coached a development team of four.\n\nResponsibilities:\n- Oversaw all technological operations, including AWS/DigitalOcean, quality standards, client relations, and infrastructure management.\n- Developed across multiple platforms including CakePHP, Vue.js, Node.js, WordPress, CraftCMS, and Shopify.\n- Conducted SCRUM meetings and managed day-to-day and long-term goals for the tech department.', source: 'resume' },

  { category: 'experience', key: 'Mihlfeld and Associates - Programmer', value: 'May 2018 - Apr 2019 | Springfield, MO\n\nAccomplishments:\n- Generated reports from over a billion records using Kafka, MongoDB, Redis, Elasticsearch, and Kubernetes.\n- Transitioned a PHP monolithic application to a Node.js microservice architecture, improving response times by over 1000%.\n- Implemented real-time transit information using Socket.IO.\n\nResponsibilities:\n- Led the redesign of a transit management application, optimizing performance with massive datasets.\n- Participated in SCRUM meetings and worked with various departments.', source: 'resume' },

  // Education
  { category: 'education', key: 'Missouri State University', value: 'Computer Science | Springfield, MO', source: 'resume' },

  // Projects
  { category: 'project', key: 'Car Wash AI', value: 'SaaS Application | Sold to national carwash chain in 2023\n\n- Developed a comprehensive car wash operational software system to help owners manage maintenance, repairs, inventory, daily checklists, and damage claims.\n- Transitioned manual workflows to a cloud-based system, providing operators with actionable insights.\n- Technologies: Laravel API, Vue.js frontend, CapacitorJS for mobile (iOS and Android).\n- Successfully sold the business to a car wash chain.\n- Led product development from ideation to deployment, overseeing software development, client relations, sales, and business operations.', source: 'resume' },

  // Preferences (inferred from resume context)
  { category: 'preference', key: 'Work Style', value: 'Remote preferred. Currently working remote at Applied Imagination.', source: 'inferred' },
  { category: 'preference', key: 'Target Salary', value: '$150,000+ USD', source: 'inferred' },
  { category: 'preference', key: 'Leadership Interest', value: 'Interested in senior developer and technical leadership roles. Has CTO and team lead experience.', source: 'inferred' },
  { category: 'preference', key: 'Industry Focus', value: 'Open to all industries. Experience in real estate, transportation/logistics, car wash/automotive, and web development consulting.', source: 'inferred' },
]

// Insert entries
let inserted = 0
for (const entry of entries) {
  try {
    db.insert(knowledgeEntries).values(entry).run()
    inserted++
    console.log(`  [${entry.category}] ${entry.key}`)
  } catch (e: any) {
    console.error(`  Failed: ${entry.key} - ${e.message}`)
  }
}

// Create default search config
db.insert(searchConfigs).values({
  name: 'Senior Developer - Remote',
  keywords: JSON.stringify(['senior developer', 'senior software engineer', 'staff engineer', 'tech lead', 'engineering manager']),
  excludedKeywords: JSON.stringify(['junior', 'intern', 'entry level', '.NET', 'C#', 'Java']),
  locations: JSON.stringify(['Remote', 'United States']),
  remoteOnly: true,
  salaryMin: 150000,
  salaryCurrency: 'USD',
  jobSources: JSON.stringify(['jsearch', 'adzuna', 'remotive']),
  isActive: true,
}).run()

console.log(`\nSeeded ${inserted} knowledge entries and 1 search config.`)
console.log('Done!')

sqlite.close()
