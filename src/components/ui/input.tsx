import { cn } from '../../lib/utils'
import type { InputHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export default function Input({ label, className, id, ...props }: InputProps) {
  return (
    <div className="space-y-1">
      {label && <label htmlFor={id} className="block text-sm font-medium text-slate-700">{label}</label>}
      <input
        id={id}
        className={cn(
          'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500 [font-size:16px]',
          className,
        )}
        {...props}
      />
    </div>
  )
}
