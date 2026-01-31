import React, { useState, useEffect } from 'react';
import { apiService } from '../services/apiService';
import { KBArticle } from '../types';
import { Search, BookOpen, Tag, ChevronRight, Hash, Loader2 } from 'lucide-react';

const KnowledgeBaseView: React.FC = () => {
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | 'All'>('All');
  const [selectedArticle, setSelectedArticle] = useState<KBArticle | null>(null);
  const [articles, setArticles] = useState<KBArticle[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Fetch all articles on mount for local filtering speed
    apiService.searchKnowledgeBase("").then(data => {
      setArticles(data);
      setIsLoading(false);
    });
  }, []);

  const categories = ['All', ...new Set(articles.map(a => a.category).filter(Boolean))];

  const filteredArticles = articles.filter(article => {
    const matchesQuery =
      article.title.toLowerCase().includes(query.toLowerCase()) ||
      article.content.toLowerCase().includes(query.toLowerCase()) ||
      (article.keywords && article.keywords.some(k => k.toLowerCase().includes(query.toLowerCase())));
    const matchesCategory = selectedCategory === 'All' || article.category === selectedCategory;
    return matchesQuery && matchesCategory;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
        <h2 className="text-2xl font-display font-bold text-primary_1 flex items-center gap-2">
          <BookOpen className="text-primary_3" />
          Staff Knowledge Base
        </h2>
        <div className="relative w-full md:w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
          <input
            type="text"
            placeholder="Search for solutions (e.g. VPN, Printer)..."
            className="w-full pl-10 pr-4 py-3 bg-white rounded-xl border-2 border-transparent focus:border-primary_3 focus:ring-4 focus:ring-primary_3/10 transition-all outline-none shadow-sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2 pb-2">
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-4 py-2 rounded-full text-sm font-semibold transition-all border ${selectedCategory === cat
                ? 'bg-primary_1 text-white border-primary_1 shadow-md'
                : 'bg-white text-primary_1 border-gray-200 hover:border-primary_3'
              }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="animate-spin text-primary_1" size={48} />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredArticles.map(article => (
            <div
              key={article.id}
              onClick={() => setSelectedArticle(article)}
              className="group bg-white p-6 rounded-2xl border border-gray-100 hover:border-primary_3 shadow-sm hover:shadow-xl transition-all cursor-pointer flex flex-col h-full"
            >
              <div className="flex items-start justify-between mb-4">
                <span className="bg-primary_3/10 text-primary_1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded">
                  {article.category}
                </span>
                <Hash className="text-gray-200 group-hover:text-primary_3 transition-colors" size={16} />
              </div>
              <h3 className="text-lg font-display font-bold text-primary_1 mb-2 group-hover:text-teal_accent transition-colors">
                {article.title}
              </h3>
              <p className="text-sm text-gray-500 line-clamp-3 mb-6 flex-1">
                {article.content}
              </p>
              <div className="flex items-center text-primary_3 text-sm font-bold mt-auto group-hover:translate-x-1 transition-transform">
                View Solution <ChevronRight size={16} />
              </div>
            </div>
          ))}
        </div>
      )}

      {!isLoading && filteredArticles.length === 0 && (
        <div className="text-center py-20 bg-white rounded-3xl border-2 border-dashed border-gray-100">
          <BookOpen size={48} className="mx-auto text-gray-200 mb-4" />
          <p className="text-gray-500 font-medium">No articles found matching your search.</p>
          <button onClick={() => { setQuery(''); setSelectedCategory('All'); }} className="mt-4 text-primary_3 font-bold hover:underline">Clear all filters</button>
        </div>
      )}

      {selectedArticle && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-primary_1/20 backdrop-blur-sm animate-in fade-in duration-300">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden border border-gray-100 flex flex-col max-h-[90vh]">
            <div className="bg-pale_grey p-6 border-b flex items-center justify-between">
              <div>
                <span className="text-[10px] font-bold text-primary_3 uppercase tracking-widest">{selectedArticle.category}</span>
                <h2 className="text-xl font-display font-bold text-primary_1">{selectedArticle.title}</h2>
              </div>
              <button
                onClick={() => setSelectedArticle(null)}
                className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-200 transition-colors"
              >
                ×
              </button>
            </div>
            <div className="p-8 overflow-y-auto text-primary_1 leading-relaxed">
              <div className="whitespace-pre-wrap mb-8 text-lg">
                {selectedArticle.content}
              </div>
              <div className="flex flex-wrap gap-2 border-t pt-6">
                {selectedArticle.keywords.map(k => (
                  <span key={k} className="flex items-center gap-1 text-[11px] font-bold text-gray-400 bg-gray-50 px-2 py-1 rounded border">
                    <Tag size={10} /> {k}
                  </span>
                ))}
              </div>
            </div>
            <div className="p-6 bg-pale_grey border-t flex justify-end">
              <button
                onClick={() => setSelectedArticle(null)}
                className="px-6 py-2 bg-primary_1 text-white font-bold rounded-xl hover:bg-teal_deep transition-colors"
              >
                Close Article
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default KnowledgeBaseView;
